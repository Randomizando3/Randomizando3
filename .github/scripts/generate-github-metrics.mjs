import { mkdir, writeFile } from 'node:fs/promises';

const owner = process.env.GITHUB_OWNER || 'Randomizando3';
const token = process.env.GITHUB_TOKEN_STATS || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  throw new Error('Missing GITHUB_TOKEN_STATS, GITHUB_TOKEN, or GH_TOKEN.');
}

const ownerLower = owner.toLowerCase();
const now = new Date();
const currentYear = now.getUTCFullYear();
const yearStart = new Date(Date.UTC(currentYear, 0, 1));
const activityStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Randomizando3-profile-metrics',
};

function iso(date) {
  return date.toISOString();
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function githubJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return {
    data: await response.json(),
    link: response.headers.get('link') || '',
  };
}

function nextLink(linkHeader) {
  const next = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));
  if (!next) return null;
  const match = next.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function getAllPages(url) {
  const results = [];
  let next = url;
  while (next) {
    const { data, link } = await githubJson(next);
    results.push(...data);
    next = nextLink(link);
  }
  return results;
}

async function collectMetrics() {
  const repos = await getAllPages(
    'https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator&sort=pushed&per_page=100',
  );

  const ownedRepos = repos.filter((repo) => repo.owner?.login?.toLowerCase() === ownerLower && !repo.fork);
  const activeRepos = ownedRepos.filter((repo) => !repo.archived);
  const publicRepos = ownedRepos.filter((repo) => !repo.private).length;
  const privateRepos = ownedRepos.filter((repo) => repo.private).length;

  const days = new Map();
  for (let offset = 30; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    days.set(dayKey(date), 0);
  }

  let commitsThisYear = 0;
  const repoErrors = [];

  for (const repo of activeRepos) {
    const url = `https://api.github.com/repos/${repo.full_name}/commits?author=${encodeURIComponent(owner)}&since=${encodeURIComponent(iso(yearStart))}&per_page=100`;
    let commits = [];
    try {
      commits = await getAllPages(url);
    } catch (error) {
      repoErrors.push(`${repo.full_name}: ${error.message}`);
      continue;
    }

    for (const commit of commits) {
      const commitDate = new Date(commit.commit?.author?.date || commit.commit?.committer?.date || commit.author?.date);
      if (Number.isNaN(commitDate.getTime())) continue;
      if (commitDate >= yearStart) commitsThisYear += 1;
      if (commitDate >= activityStart) {
        const key = dayKey(commitDate);
        if (days.has(key)) days.set(key, days.get(key) + 1);
      }
    }
  }

  const dayEntries = [...days.entries()];
  const last31Commits = dayEntries.reduce((sum, [, count]) => sum + count, 0);
  const currentStreak = getCurrentStreak(dayEntries);
  const longestStreak = getLongestStreak(dayEntries);
  const maxDaily = Math.max(1, ...dayEntries.map(([, count]) => count));

  return {
    owner,
    generatedAt: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    currentYear,
    commitsThisYear,
    repoCount: ownedRepos.length,
    publicRepos,
    privateRepos,
    last31Commits,
    currentStreak,
    longestStreak,
    maxDaily,
    days: dayEntries,
    repoErrors,
  };
}

function getCurrentStreak(dayEntries) {
  let streak = 0;
  for (let index = dayEntries.length - 1; index >= 0; index -= 1) {
    if (dayEntries[index][1] > 0) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

function getLongestStreak(dayEntries) {
  let longest = 0;
  let current = 0;
  for (const [, count] of dayEntries) {
    if (count > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function metric(x, y, label, value, accent = '#70a5fd') {
  return `
    <g transform="translate(${x}, ${y})">
      <text x="0" y="0" fill="#a9b1d6" font-size="14">${escapeXml(label)}</text>
      <text x="0" y="42" fill="${accent}" font-size="34" font-weight="700">${escapeXml(value)}</text>
    </g>`;
}

function statsSvg(metrics) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="220" viewBox="0 0 840 220" role="img" aria-label="GitHub metrics for ${escapeXml(metrics.owner)}">
  <style>
    .title { font: 700 24px 'Segoe UI', Ubuntu, sans-serif; }
    text { font-family: 'Segoe UI', Ubuntu, sans-serif; }
  </style>
  <rect width="840" height="220" rx="8" fill="#1a1b27"/>
  <text x="28" y="42" class="title" fill="#70a5fd">GitHub Metrics</text>
  <text x="28" y="68" fill="#a9b1d6" font-size="13">Private-aware summary generated from authenticated GitHub data</text>
  ${metric(32, 120, `${metrics.currentYear} commits`, metrics.commitsThisYear, '#38bdae')}
  ${metric(230, 120, 'Last 31 days', metrics.last31Commits, '#bf91f3')}
  ${metric(420, 120, 'Current streak', `${metrics.currentStreak}d`, '#70a5fd')}
  ${metric(610, 120, 'Repos', metrics.repoCount, '#38bdae')}
  <text x="610" y="184" fill="#a9b1d6" font-size="13">${metrics.publicRepos} public / ${metrics.privateRepos} private</text>
  <text x="28" y="204" fill="#565f89" font-size="12">Updated ${escapeXml(metrics.generatedAt)}</text>
</svg>
`;
}

function activitySvg(metrics) {
  const width = 1200;
  const height = 420;
  const chart = { left: 80, top: 82, right: 40, bottom: 70 };
  const chartWidth = width - chart.left - chart.right;
  const chartHeight = height - chart.top - chart.bottom;
  const entries = metrics.days;
  const step = chartWidth / Math.max(1, entries.length - 1);
  const points = entries.map(([, count], index) => {
    const x = chart.left + index * step;
    const y = chart.top + chartHeight - (count / metrics.maxDaily) * chartHeight;
    return { x, y, count, date: entries[index][0] };
  });

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');

  const areaPath = `${path} L${chart.left + chartWidth},${chart.top + chartHeight} L${chart.left},${chart.top + chartHeight} Z`;

  const labels = points
    .filter((_, index) => index % 5 === 0 || index === points.length - 1)
    .map((point) => {
      const day = Number(point.date.slice(8, 10));
      return `<text x="${point.x.toFixed(2)}" y="${height - 28}" fill="#a9b1d6" font-size="13" text-anchor="middle">${day}</text>`;
    })
    .join('\n');

  const circles = points
    .map((point) => {
      const radius = point.count > 0 ? 5 : 3;
      const fill = point.count > 0 ? '#70a5fd' : '#565f89';
      return `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius}" fill="${fill}"><title>${escapeXml(point.date)}: ${point.count} commits</title></circle>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420" role="img" aria-label="Private-aware activity graph for ${escapeXml(metrics.owner)}">
  <style>
    text { font-family: 'Segoe UI', Ubuntu, sans-serif; }
  </style>
  <rect width="1200" height="420" rx="8" fill="#1a1b27"/>
  <text x="40" y="42" fill="#70a5fd" font-size="24" font-weight="700">Activity Graph</text>
  <text x="40" y="68" fill="#a9b1d6" font-size="14">Last 31 days, including private repositories accessible to the profile token</text>
  <line x1="${chart.left}" x2="${chart.left + chartWidth}" y1="${chart.top + chartHeight}" y2="${chart.top + chartHeight}" stroke="#565f89" stroke-width="1"/>
  <line x1="${chart.left}" x2="${chart.left + chartWidth}" y1="${chart.top}" y2="${chart.top}" stroke="#565f89" stroke-width="1" opacity="0.35"/>
  <text x="42" y="${chart.top + 4}" fill="#a9b1d6" font-size="13">${metrics.maxDaily}</text>
  <text x="48" y="${chart.top + chartHeight + 4}" fill="#a9b1d6" font-size="13">0</text>
  <path d="${areaPath}" fill="#70a5fd" opacity="0.12"/>
  <path d="${path}" fill="none" stroke="#70a5fd" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
  ${circles}
  ${labels}
  <text x="40" y="392" fill="#565f89" font-size="12">Updated ${escapeXml(metrics.generatedAt)}</text>
</svg>
`;
}

const metrics = await collectMetrics();
await mkdir('assets', { recursive: true });
await writeFile('assets/github-stats.svg', statsSvg(metrics), 'utf8');
await writeFile('assets/github-activity.svg', activitySvg(metrics), 'utf8');

if (metrics.repoErrors.length > 0) {
  console.warn('Some repositories could not be scanned:');
  for (const error of metrics.repoErrors) console.warn(`- ${error}`);
}
