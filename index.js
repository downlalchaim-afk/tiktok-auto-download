const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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
  if (url.startsWith('http')) return url;

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
  const filePath = res.stdout.trim().split('\n').find(x => x.endsWith('.mp4'));

  if (filePath && fs.existsSync(filePath)) return filePath;
  return null;
}

async function downloadFile(url, savePath) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 60000,
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
      timeout: 60000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      }
    }
  );

  const data = response.data?.data;
  if (!data) return null;

  const videoLink = data.hdplay || data.play || data.wmplay;
  if (!videoLink) return null;

  const savePath = path.join(userDir, `${videoId}.mp4`);
  await downloadFile(videoLink, savePath);

  return fs.existsSync(savePath) ? savePath : null;
}

async function processUsername(username) {
  const userDir = path.join(downloadDir, username);
  const archiveFile = path.join(downloadDir, `${username}.txt`);

  fs.mkdirSync(userDir, { recursive: true });

  console.log(`Checking @${username}`);

  const videoUrl = await getLatestVideoUrl(username);

  if (!videoUrl) {
    console.log(`@${username}: tidak menemukan video terbaru`);
    return;
  }

  const videoId = getVideoId(videoUrl);

  if (!videoId) {
    console.log(`@${username}: tidak bisa membaca video ID`);
    return;
  }

  if (isDownloaded(archiveFile, videoId)) {
    console.log(`@${username}: tidak ada video baru`);
    return;
  }

  let filePath = await downloadWithYtDlp(videoUrl, videoId, userDir);

  if (!filePath) {
    filePath = await downloadWithFallback(videoUrl, videoId, userDir);
  }

  if (filePath) {
    markDownloaded(archiveFile, videoId);
    console.log(`@${username}: downloaded ${filePath}`);
  } else {
    console.log(`@${username}: gagal download video terbaru`);
  }
}

async function main() {
  for (const username of usernames) {
    try {
      await processUsername(username);
    } catch (err) {
      console.log(`@${username}: error ${err.message}`);
    }
  }
}

main();