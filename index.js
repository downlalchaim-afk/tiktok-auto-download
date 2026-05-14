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
    `Video baru dari @${username}\nID: ${videoId}`
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

  console.log(`@${username}: video terkirim ke Telegram`);
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

  await sendToTelegram(filePath, username, videoId);

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