const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(x => x.trim());
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Organization-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

async function supabase(pathname, options = {}, key = publishableKey) {
  if (!supabaseUrl || !key) throw new Error('Supabase não configurado no servidor.');
  const headers = { apikey: key, ...(options.headers || {}) };
  const response = await fetch(`${supabaseUrl}${pathname}`, { ...options, headers });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : await response.text();
  if (!response.ok) throw Object.assign(new Error(data?.msg || data?.message || 'Falha no Supabase.'), { status: response.status });
  return data;
}

async function authenticatedUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw Object.assign(new Error('Sessão ausente.'), { status: 401 });
  return supabase('/auth/v1/user', { headers: { Authorization: auth } });
}

async function userOrganizations(token, userId) {
  return supabase(`/rest/v1/organization_members?select=organization_id,role&user_id=eq.${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function routeApi(req, res, url) {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/health') {
    return json(res, 200, { service: 'prowhats-api', status: 'ok', supabaseConfigured: Boolean(supabaseUrl && publishableKey), timestamp: new Date().toISOString() });
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const { email, password } = await readJson(req);
    if (!email || !password) return json(res, 400, { error: 'Informe e-mail e senha.' });
    const session = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return json(res, 200, session);
  }
  if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
    const { email, password, fullName } = await readJson(req);
    if (!email || !password || password.length < 8) return json(res, 400, { error: 'Use um e-mail e senha de ao menos 8 caracteres.' });
    const created = await supabase('/auth/v1/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, data: { full_name: fullName || '' } }) });
    return json(res, 201, created);
  }
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const user = await authenticatedUser(req);
    const token = req.headers.authorization.slice(7);
    const organizations = await userOrganizations(token, user.id);
    return json(res, 200, { user: { id: user.id, email: user.email, metadata: user.user_metadata }, organizations });
  }
  if (url.pathname === '/api/onboarding' && req.method === 'POST') {
    if (!secretKey) return json(res, 503, { error: 'SUPABASE_SECRET_KEY não está configurada no Railway.' });
    const user = await authenticatedUser(req);
    const { organizationName } = await readJson(req);
    const name = (organizationName || '').trim();
    if (name.length < 2) return json(res, 400, { error: 'Informe o nome da empresa.' });
    const slug = `${name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
    const [organization] = await supabase('/rest/v1/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ name, slug }) }, secretKey);
    await supabase('/rest/v1/organization_members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organization_id: organization.id, user_id: user.id, role: 'owner' }) }, secretKey);
    return json(res, 201, { organization });
  }
  if (url.pathname === '/api/flows') {
    const user = await authenticatedUser(req);
    const token = req.headers.authorization.slice(7);
    const organizations = await userOrganizations(token, user.id);
    const organizationId = req.headers['x-organization-id'] || organizations[0]?.organization_id;
    if (!organizationId) return json(res, 409, { error: 'Conclua o cadastro da empresa antes de criar fluxos.' });
    if (req.method === 'GET') {
      const flows = await supabase(`/rest/v1/flows?select=*&organization_id=eq.${encodeURIComponent(organizationId)}&order=updated_at.desc`, { headers: { Authorization: `Bearer ${token}` } });
      return json(res, 200, { flows, organizationId });
    }
    if (req.method === 'POST') {
      const { name, description } = await readJson(req);
      if (!name?.trim()) return json(res, 400, { error: 'Informe o nome do fluxo.' });
      const [flow] = await supabase('/rest/v1/flows', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ organization_id: organizationId, name: name.trim(), description: description || null, created_by: user.id }) });
      return json(res, 201, { flow });
    }
  }
  return json(res, 404, { error: 'Rota de API não encontrada.' });
}

http.createServer(async (req, res) => {
  setCors(req, res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await routeApi(req, res, url);
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const safe = path.normalize(file).replace(/^(\.\.([\\/]|$))+/, '');
    const target = path.join(root, safe);
    if (!target.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(target, (error, content) => {
      if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); return res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
      res.end(content);
    });
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.message || 'Erro interno.' });
  }
}).listen(port, host, () => console.log(`ProWhats API em http://${host}:${port}`));
