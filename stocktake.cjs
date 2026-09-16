// 可樂旅遊行程盤點：由 GitHub Actions 每週執行，產出網站用的 cola-index.js
// 做的事跟「盤點可樂行程」書籤一樣：用瀏覽器打開官網搜尋頁，把行程清單讀下來。

const { chromium } = require('playwright');
const { writeFileSync, appendFileSync } = require('node:fs');

const KEYS = ['日本', '韓國', '中國', '港澳', '泰國', '越南', '新加坡', '馬來西亞', '印尼', '菲律賓',
  '印度', '杜拜', '土耳其', '埃及', '歐洲', '紐西蘭', '澳洲', '美國', '加拿大', '郵輪', '帛琉', '關島'];
const CITIES = ['TPE', 'TXG', 'KHH'];
const CITY_NAME = { TPE: '台北', TXG: '台中', KHH: '高雄' };
const MIN_OK = 1000;   // 少於這個筆數就不更新，避免把壞掉的資料放上網站
const PARALLEL = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

async function grab(context, kw, code) {
  const page = await context.newPage();
  const url = 'https://tour.colatour.com.tw/search?KeyWord=' + encodeURIComponent(kw) + '&DepartureCity=' + code;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等清單長完：連結數連續三次沒變才算好
    let last = -1, same = 0;
    for (let i = 0; i < 25 && same < 3; i++) {
      await page.waitForTimeout(1500);
      const n = await page.locator('a[href*="itinerary?PatternNo"]').count();
      if (n === last && n > 0) same++; else same = 0;
      last = n;
    }

    const title = await page.title();
    const rows = await page.evaluate(([kw, code]) => {
      const m = new Map();
      document.querySelectorAll('a[href*="itinerary?PatternNo"]').forEach((a) => {
        const mm = (a.getAttribute('href') || '').match(/PatternNo=(\d+)/);
        if (!mm) return;
        const no = mm[1];
        const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
        if (!m.has(no)) m.set(no, []);
        if (t) m.get(no).push(t);
      });
      const out = [];
      m.forEach((parts, no) => {
        let name = parts.find((p) => p.length > 12 && !/^[\d\/\s,.]+$/.test(p)) || '';
        const pm = name.match(/\$([\d,]+)起/);
        const price = pm ? pm[1].replace(/,/g, '') : '';
        name = name.replace(/\s*\$[\d,]+起\s*$/, '').replace(/\t/g, ' ').trim();
        const dates = (parts.find((p) => /^\d{2}\/\d{2}/.test(p)) || '')
          .replace(/\s*\.\.\.$/, '').replace(/\s+/g, ',');
        if (name) out.push([no, name, price, dates, kw, code].join('\t'));
      });
      return out;
    }, [kw, code]);

    const blocked = /just a moment|attention required|verify you are human/i.test(title);
    console.log('  ' + CITY_NAME[code] + '出發 ' + kw + '：' + rows.length + ' 筆' + (blocked ? '（官網顯示驗證頁：' + title + '）' : ''));
    return rows;
  } catch (e) {
    console.log('  ' + CITY_NAME[code] + '出發 ' + kw + '：失敗（' + String(e.message).split('\n')[0] + '）');
    return [];
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 20000 },   // 視窗要夠高，搜尋結果才會整份長出來
    userAgent: UA,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });

  const all = [];
  const seen = new Set();
  for (const code of CITIES) {
    for (let i = 0; i < KEYS.length; i += PARALLEL) {
      const batch = KEYS.slice(i, i + PARALLEL);
      const results = await Promise.all(batch.map((kw) => grab(context, kw, code)));
      for (const rows of results) {
        for (const line of rows) {
          const p = line.split('\t');
          const key = p[0] + '|' + p[5];
          if (!seen.has(key)) { seen.add(key); all.push(line); }
        }
      }
    }
  }
  await browser.close();

  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const count = (c) => all.filter((l) => l.split('\t')[5] === c).length;

  const summary = [
    '## 行程資料盤點結果',
    '',
    '- 擷取日：' + ymd,
    '- 總筆數：' + all.length,
    '- 台北出發 ' + count('TPE') + '　台中出發 ' + count('TXG') + '　高雄出發 ' + count('KHH'),
  ];
  const ok = all.length >= MIN_OK;
  if (!ok) {
    summary.push('', '**只抓到 ' + all.length + ' 筆，比平常（約 2000 筆）少很多，這次不更新。**',
      '網站上原本的資料照常使用，不受影響。可能是官網暫時擋住或改版；下週會自動再試。');
  }
  console.log(summary.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  if (!ok) process.exit(1);

  // 全檔只用英數字元：中文轉成反斜線 u 加四碼，任何主機、任何瀏覽器都不會讀錯
  const text = '#可樂旅遊行程索引\t擷取日=' + ymd + '\t筆數=' + all.length + '\n' + all.join('\n');
  const raw = JSON.stringify(text);
  const BS = String.fromCharCode(92);
  let body = '';
  for (let q = 0; q < raw.length; q++) {
    const cc = raw.charCodeAt(q);
    body += cc < 127 ? raw.charAt(q) : BS + 'u' + ('000' + cc.toString(16)).slice(-4);
  }
  writeFileSync('cola-index.js',
    '/* colatour itinerary index | captured ' + ymd + ' | rows ' + all.length + ' */\nwindow.COLA_RAW=' + body + ';\n');
  console.log('已寫入 cola-index.js');
}

main().catch((e) => { console.error(e); process.exit(1); });
