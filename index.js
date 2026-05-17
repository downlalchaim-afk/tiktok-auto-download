const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const usernames = (process.env.TIKTOK_USERNAME || '')
  .split(',')
  .map(u => u.trim().replace('@', ''))
  .filter(Boolean);

const downloadDir = process.env.DOWNLOAD_DIR || 'downloads';

if (usernames.length === 0) {
  console.error('TIKTOK_USERNAME belum diisi');
  process.exit(1);
}

function runYtDlp(args) {
  return new Promise(resolve => {
    const child = execFile('yt-dlp', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: 1, stdout, stderr: err.message }));
  });
}

// Fungsi Baru: Memproses video agar unik menggunakan FFmpeg
function makeVideoUnique(inputPath, outputPath) {
  return new Promise(resolve => {
    // Trik Anti-Duplikat:
    // 1. Mirror video secara horizontal (hflip)
    // 2. Naikkan kecepatan video tipis (1.02x) agar durasi berubah sedikit
    // 3. Naikkan pitch audio agar selaras dengan kecepatan baru (atempo=1.02)
    // 4. Hapus semua metadata asli (-map_metadata -1)
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', 'hflip,setpts=0.9803*PTS',
      '-af', 'atempo=1.02',
      '-map_metadata', '-1',
      outputPath
    ];

    const child = execFile('ffmpeg', args, { windowsHide: true });

    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());

    child.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        console.error('FFmpeg error:', stderr);
        resolve(null);
      }
    });
    child.on('error', err => {
      console.error('FFmpeg process error:', err.message);
      resolve(null);
    });
  });
}

function isDownloaded(archiveFile, videoId) {
  if (!fs.existsSync(archiveFile)) return false;
  return fs.readFileSync(archiveFile, 'utf8').includes(videoId);
}

function markDownloaded(archiveFile, videoId) {
  fs.appendFileSync(archiveFile, `${videoId}\n`);
}

function getVideoId(videoUrl) {
  const match = videoUrl.match(/video\/(\d+)/);
  return match ? match[1] : null;
}

async function getLatestVideoUrl(username) {
  const profileUrl = `https://www.tiktok.com/@${username}`;

  const args = [
    profileUrl,
    '--playlist-items', '1',
    '--flat-playlist',
    '--print', '%(url)s',
    '--quiet',
    '--no-warnings'
  ];

  const res = await runYtDlp(args);
  const url = res.stdout.trim().split('\n').filter(Boolean)[0];

  if (!url) return null;

  if (url.startsWith('http')) {
    return url;
  }

  return `https://www.tiktok.com/@${username}/video/${url}`;
}

async function downloadWithYtDlp(videoUrl, videoId, userDir) {
  const args = [
    videoUrl,
    '--no-playlist',
    '--no-overwrites',
    '--quiet',
    '--no-warnings',

    '-f',
    'b[ext=mp4]/best[ext=mp4]/best',

    '--print',
    'after_move:filepath',

    '-o',
    path.join(userDir, `${videoId}.%(ext)s`)
  ];

  const res = await runYtDlp(args);

  const filePath = res.stdout
    .trim()
    .split('\n')
    .find(x => x.endsWith('.mp4'));

  if (filePath && fs.existsSync(filePath)) {
    return filePath;
  }

  return null;
}

async function downloadFile(url, savePath) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 120000,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(savePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return savePath;
}

async function downloadWithFallback(videoUrl, videoId, userDir) {
  const response = await axios.post(
    'https://www.tikwm.com/api/',
    new URLSearchParams({
      url: videoUrl,
      hd: '1'
    }),
    {
      timeout: 120000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      }
    }
  );

  const data = response.data?.data;

  if (!data) return null;

  const videoLink =
    data.hdplay ||
    data.play ||
    data.wmplay;

  if (!videoLink) return null;

  const savePath = path.join(userDir, `${videoId}.mp4`);

  await downloadFile(videoLink, savePath);

  if (fs.existsSync(savePath)) {
    return savePath;
  }

  return null;
}

async function sendToTelegram(filePath, username, videoId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('Telegram secret belum diisi');
    return;
  }

  const form = new FormData();

  form.append('chat_id', chatId);
  form.append(
    'caption',
    `Video unik baru dari @${username}\nID: ${videoId}`
  );
  form.append('video', fs.createReadStream(filePath));

  await axios.post(
    `https://api.telegram.org/bot${token}/sendVideo`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    }
  );

  console.log(`@${username}: video unik terkirim ke Telegram`);
}

async function processUsername(username) {
  const userDir = path.join(downloadDir, username);
  const archiveFile = path.join(downloadDir, `${username}.txt`);

  fs.mkdirSync(userDir, { recursive: true });

  console.log(`Checking @${username}`);

  const videoUrl = await getLatestVideoUrl(username);

  if (!videoUrl) {
    console.log(`@${username}: tidak menemukan video`);
    return;
  }

  const videoId = getVideoId(videoUrl);

  if (!videoId) {
    console.log(`@${username}: gagal baca video ID`);
    return;
  }

  if (isDownloaded(archiveFile, videoId)) {
    console.log(`@${username}: tidak ada video baru`);
    return;
  }

  let filePath = await downloadWithYtDlp(
    videoUrl,
    videoId,
    userDir
  );

  if (!filePath) {
    filePath = await downloadWithFallback(
      videoUrl,
      videoId,
      userDir
    );
  }

  if (!filePath) {
    console.log(`@${username}: gagal download`);
    return;
  }

  // --- PROSES MODIFIKASI ANTI-DUPLIKAT ---
  const uniqueFilePath = path.join(userDir, `unique_${videoId}.mp4`);
  console.log(`@${username}: Sedang memproses video agar lolos algoritma reupload...`);
  
  const processedPath = await makeVideoUnique(filePath, uniqueFilePath);
  
  if (processedPath) {
    // Kirim video yang sudah dimodifikasi (unik) ke Telegram
    await sendToTelegram(processedPath, username, videoId);
    
    // Hapus kedua file agar penyimpanan Runner GitHub Actions tidak penuh
    try {
      fs.unlinkSync(filePath);       // Hapus video original mentah
      fs.unlinkSync(processedPath);  // Hapus video unik
    } catch (e) {}
  } else {
    // Jika FFmpeg gagal karena alasan tertentu, kirim video original sebagai cadangan
    console.log(`@${username}: Gagal membuat video unik. Mengirim video asli...`);
    await sendToTelegram(filePath, username, videoId);
    try { fs.unlinkSync(filePath); } catch (e) {}
  }
  // ---------------------------------------

  markDownloaded(archiveFile, videoId);

  console.log(`@${username}: selesai`);
}

async function main() {
  for (const username of usernames) {
    try {
      await processUsername(username);
    } catch (err) {
      console.log(`@${username}: ${err.message}`);
    }
  }
}

main();
