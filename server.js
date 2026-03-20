/**
 * agrix CORS 프록시 서버 (세션 쿠키 자동 획득 버전)
 *
 * [작동 방식]
 * 1. 서버 시작 시 agrix 메인 페이지에 GET 요청 → JSESSIONID 쿠키 획득
 * 2. 이후 모든 API 요청에 해당 쿠키 포함 → 정상 JSON 응답
 *
 * 실행: node server.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT       = 3031;
const AGRIX_HOST = 'uni.agrix.go.kr';
const SESSION_URL = '/docs7/biOlap/fixType.do?reportId=eqpt_oudor_area_item';

let SESSION_COOKIE = ''; // 자동 획득한 세션 쿠키 저장

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

/* =====================================================
   세션 쿠키 획득 함수
   agrix는 두 가지 쿠키가 모두 필요:
   - docs_uniSEID  : /docs/ 경로 방문 시 발급
   - docs7_uniSEID : /docs7/ 경로 방문 시 발급
===================================================== */
function httpsGet(path, cookies) {
  return new Promise((resolve) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    };
    if (cookies) headers['Cookie'] = cookies;

    const req = https.request({ hostname: AGRIX_HOST, port: 443, path, method: 'GET', headers }, (res) => {
      const setCookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
      res.resume();
      resolve({ status: res.statusCode, cookies: setCookies, location: res.headers['location'] });
    });
    req.on('error', () => resolve({ status: 0, cookies: [] }));
    req.end();
  });
}

function mergeCookies(existing, newCookies) {
  const map = {};
  // 기존 쿠키 파싱
  (existing || '').split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) map[k.trim()] = v;
  });
  // 새 쿠키 덮어쓰기
  newCookies.forEach(c => {
    const [k, v] = c.split('=');
    if (k) map[k.trim()] = v;
  });
  return Object.entries(map).map(([k,v]) => `${k}=${v}`).join('; ');
}

async function acquireSession() {
  console.log('[세션] agrix 세션 쿠키 획득 시작...');

  // 1단계: 메인 페이지 접속 (SCOUTER 쿠키)
  const r1 = await httpsGet('/docs7/biOlap/fixType.do?reportId=eqpt_oudor_area_item', '');
  SESSION_COOKIE = mergeCookies('', r1.cookies);
  console.log(`[세션] 1단계 쿠키: ${SESSION_COOKIE.slice(0, 80)}...`);

  // 2단계: /docs/ 경로 방문 → docs_uniSEID 획득
  const r2 = await httpsGet('/docs/main.do', SESSION_COOKIE);
  SESSION_COOKIE = mergeCookies(SESSION_COOKIE, r2.cookies);
  console.log(`[세션] 2단계 쿠키 추가: +${r2.cookies.length}개`);

  // 3단계: 데이터 조회 페이지 재방문 → 세션 활성화
  const r3 = await httpsGet('/docs7/biOlap/fixType.do?reportId=eqpt_oudor_area_item', SESSION_COOKIE);
  SESSION_COOKIE = mergeCookies(SESSION_COOKIE, r3.cookies);
  console.log(`[세션] 최종 쿠키: ${SESSION_COOKIE.slice(0, 120)}`);

  if (!SESSION_COOKIE.includes('uniSEID')) {
    console.log('[세션] ⚠️  uniSEID 쿠키 없음 - 데이터 조회가 실패할 수 있습니다');
  } else {
    console.log('[세션] ✅ 세션 준비 완료');
  }
}


/* =====================================================
   agrix API 프록시 요청
===================================================== */
function proxyToAgrix(targetPath, method, body, res) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://${AGRIX_HOST}${SESSION_URL}`,
    'Origin': `https://${AGRIX_HOST}`,
  };
  if (SESSION_COOKIE) headers['Cookie'] = SESSION_COOKIE;

  console.log(`[프록시] ${method} ${targetPath}`);

  const req = https.request({ hostname: AGRIX_HOST, port: 443, path: targetPath, method, headers }, (agrixRes) => {
    // 리다이렉트 처리 (302 → 다시 세션 획득)
    if (agrixRes.statusCode === 302) {
      console.log('[프록시] 302 리다이렉트 → 세션 재획득 시도');
      agrixRes.resume();
      acquireSession().then(() => proxyToAgrix(targetPath, method, body, res));
      return;
    }

    const chunks = [];
    agrixRes.on('data', c => chunks.push(c));
    agrixRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const preview = raw.slice(0, 100).replace(/\n/g, ' ');
      console.log(`  응답: ${agrixRes.statusCode}, ${raw.length}bytes, "${preview}"`);

      const looksJson = raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[');
      if (looksJson) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(raw);
      } else {
        // HTML 수신 → 세션 만료일 수 있으므로 재획득 후 안내
        console.log('  ⚠️  HTML 수신 → 세션 갱신 필요');
        // 쿠키 갱신 시도
        const newCookies = (agrixRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        if (newCookies) SESSION_COOKIE = newCookies;

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: true,
          message: 'agrix 서버가 HTML을 반환했습니다. 세션 문제일 수 있습니다.',
          hint: 'agrix 원본 사이트에 직접 접속한 뒤 새로고침 해보세요: https://uni.agrix.go.kr/docs7/biOlap/fixType.do?reportId=eqpt_oudor_area_item',
          rawPreview: raw.slice(0, 300),
        }));
      }
    });
  });

  req.on('error', (e) => {
    console.error('[프록시] 오류:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: true, message: e.message }));
  });

  req.write(body, 'utf8');
  req.end();
}

/* =====================================================
   HTTP 서버
===================================================== */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const qIdx = req.url.indexOf('?');
  const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const search   = qIdx === -1 ? '' : req.url.slice(qIdx);

  // POST /set-cookies → 북마클릿에서 실제 브라우저 쿠키 수신
  if (pathname === '/set-cookies' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.cookies) {
          SESSION_COOKIE = data.cookies;
          console.log(`[쿠키] ✅ 브라우저 쿠키 수신 (${SESSION_COOKIE.length}자): ${SESSION_COOKIE.slice(0, 100)}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, cookieLength: SESSION_COOKIE.length }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ ok: false }));
        }
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /cookie-status → 현재 쿠키 상태 확인
  if (pathname === '/cookie-status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      hasSession: SESSION_COOKIE.includes('uniSEID'),
      cookiePreview: SESSION_COOKIE.slice(0, 60) + (SESSION_COOKIE.length > 60 ? '...' : ''),
      cookieLength: SESSION_COOKIE.length,
    }));
    return;
  }

  if (pathname.startsWith('/proxy/')) {
    // /proxy/search.do → /docs7/biOlap/search.do
    const targetPath = '/docs7/biOlap' + pathname.slice('/proxy'.length) + search;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => proxyToAgrix(targetPath, req.method, body, res));
    return;
  }


  // 정적 파일 서빙
  const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

/* =====================================================
   서버 시작 → 세션 획득 → 준비 완료
===================================================== */
server.listen(PORT, async () => {
  console.log('');
  console.log('  🌱 비료 영업 인텔리전스 서버 시작 중...');
  await acquireSession();
  console.log('');
  console.log(`  ✅ 준비 완료!`);
  console.log(`  🌐 대시보드: http://localhost:${PORT}`);
  console.log(`  종료: Ctrl+C`);
  console.log('');
});
