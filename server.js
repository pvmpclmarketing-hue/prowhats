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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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

function escapeFilter(value) { return encodeURIComponent(String(value)); }
function renderVariables(value, variables) {
  return String(value || '').replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, (_, key) => {
    const found = key.split('.').reduce((current, part) => current && current[part], variables);
    return found === undefined || found === null ? '' : String(found);
  });
}

function nodeHandles(node) {
  const type = String(node.node_type || '').toLowerCase();
  if (type === 'menu' || type === 'carrossel') {
    const options = Array.isArray(node.config?.options) ? node.config.options : [];
    return [...options.map(option => `option:${option.id}`), 'unmatched', 'timeout'];
  }
  if (type.includes('aguarda')) return ['response', 'timeout'];
  if (type === 'condicional') return ['success', 'failure'];
  if (type.includes('integra') || type.includes('ia')) return ['success', 'error'];
  return ['success'];
}

function evaluateCondition(config, variables) {
  const field = String(config.field || config.variable || 'last_response');
  const actual = field.split('.').reduce((current, part) => current && current[part], variables);
  const expected = renderVariables(config.value || '', variables);
  const operator = config.operator || 'contains';
  if (operator === 'equals') return String(actual ?? '').toLowerCase() === expected.toLowerCase();
  if (operator === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'not_empty') return String(actual ?? '').trim() !== '';
  return String(actual ?? '').toLowerCase().includes(expected.toLowerCase());
}

function simulateGraph(nodes, edges, input, initialVariables = {}) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const start = nodes.find(node => String(node.node_type).toLowerCase() === 'início' || String(node.node_type).toLowerCase() === 'inicio') || nodes[0];
  const variables = { ...initialVariables };
  const trace = [], messages = [];
  let current = start;
  let steps = 0;
  while (current && steps++ < 50) {
    const type = String(current.node_type || '').toLowerCase();
    let handle = 'success';
    let status = 'completed';
    const config = current.config || {};
    if (type === 'mensagem' || type === 'template whatsapp') {
      const contents = Array.isArray(config.contents) && config.contents.length ? config.contents : [{ type: 'text', content: config.content || config.text || '' }];
      for (const item of contents) messages.push({ nodeKey: current.node_key, type: item.type || 'text', content: renderVariables(item.content || item.url || '', variables), typingDelaySeconds: Number(config.typingDelaySeconds) || 0 });
    } else if (type === 'menu' || type === 'carrossel') {
      if (!input) { status = 'waiting'; handle = 'timeout'; }
      else {
        const option = (config.options || []).find(item => String(item.title || '').trim().toLowerCase() === String(input).trim().toLowerCase());
        variables[config.variable || 'last_response'] = input;
        handle = option ? `option:${option.id}` : 'unmatched';
      }
    } else if (type.includes('aguarda')) {
      if (!input) { status = 'waiting'; handle = 'timeout'; }
      else { variables[config.variable || 'last_response'] = input; handle = 'response'; }
    } else if (type === 'intervalo inteligente') {
      status = 'waiting';
    } else if (type === 'condicional') {
      handle = evaluateCondition(config, variables) ? 'success' : 'failure';
    }
    trace.push({ nodeKey: current.node_key, nodeType: current.node_type, status, handle });
    if (status === 'waiting') return { status: 'waiting', waitingAt: current.node_key, variables, messages, options: (type === 'menu' || type === 'carrossel') ? (config.options || []).map(option => ({ id: option.id, title: option.title })) : [], trace };
    const edge = edges.find(item => item.source_node_id === current.id && item.source_handle === handle)
      || edges.find(item => item.source_node_id === current.id && item.source_handle === 'success');
    current = edge ? byId.get(edge.target_node_id) : null;
  }
  return { status: steps >= 50 ? 'failed' : 'completed', variables, messages, trace };
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
  const graphMatch = url.pathname.match(/^\/api\/flows\/([0-9a-f-]{36})\/graph$/i);
  const simulationMatch = url.pathname.match(/^\/api\/flows\/([0-9a-f-]{36})\/simulate$/i);
  if (graphMatch || simulationMatch) {
    const user = await authenticatedUser(req);
    const token = req.headers.authorization.slice(7);
    const memberships = await userOrganizations(token, user.id);
    const organizationId = req.headers['x-organization-id'] || memberships[0]?.organization_id;
    const flowId = (graphMatch || simulationMatch)[1];
    const foundFlows = await supabase(`/rest/v1/flows?select=id,organization_id,name,status,version&organization_id=eq.${escapeFilter(organizationId)}&id=eq.${escapeFilter(flowId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const flow = foundFlows[0];
    if (!flow) return json(res, 404, { error: 'Fluxo nao encontrado.' });
    if (graphMatch && req.method === 'GET') {
      const nodes = await supabase(`/rest/v1/flow_nodes?select=*&flow_id=eq.${escapeFilter(flowId)}&order=created_at.asc`, { headers: { Authorization: `Bearer ${token}` } });
      const edges = await supabase(`/rest/v1/flow_edges?select=*&flow_id=eq.${escapeFilter(flowId)}&order=created_at.asc`, { headers: { Authorization: `Bearer ${token}` } });
      return json(res, 200, { flow, nodes, edges });
    }
    if (graphMatch && req.method === 'PUT') {
      const { nodes, edges, name, status } = await readJson(req);
      if (!Array.isArray(nodes) || !Array.isArray(edges) || !nodes.length) return json(res, 400, { error: 'O fluxo precisa ter ao menos um no.' });
      if (nodes.length > 150 || edges.length > 400) return json(res, 400, { error: 'Limite do fluxo excedido.' });
      const keys = new Set();
      for (const node of nodes) { if (!node.id || !node.type || keys.has(node.id)) return json(res, 400, { error: 'No invalido ou repetido.' }); keys.add(node.id); }
      for (const edge of edges) { if (!keys.has(edge.source) || !keys.has(edge.target) || edge.source === edge.target) return json(res, 400, { error: 'Conexao invalida.' }); }
      await supabase(`/rest/v1/flow_edges?flow_id=eq.${escapeFilter(flowId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      await supabase(`/rest/v1/flow_nodes?flow_id=eq.${escapeFilter(flowId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const savedNodes = await supabase('/rest/v1/flow_nodes', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(nodes.map(node => ({ flow_id: flowId, node_key: String(node.id), node_type: String(node.type), position_x: Number(node.x) || 0, position_y: Number(node.y) || 0, config: { ...(node.config || {}), text: node.text || '' } }))) });
      const databaseIdByKey = new Map(savedNodes.map(node => [node.node_key, node.id]));
      if (edges.length) await supabase('/rest/v1/flow_edges', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(edges.map(edge => ({ flow_id: flowId, source_node_id: databaseIdByKey.get(edge.source), target_node_id: databaseIdByKey.get(edge.target), source_handle: edge.handle || 'success', label: edge.label || null }))) });
      const [updated] = await supabase(`/rest/v1/flows?id=eq.${escapeFilter(flowId)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ name: String(name || flow.name).slice(0, 160), status: ['draft', 'active', 'paused'].includes(status) ? status : flow.status, version: Number(flow.version || 1) + 1 }) });
      return json(res, 200, { flow: updated, nodes: savedNodes.length, edges: edges.length });
    }
    if (simulationMatch && req.method === 'POST') {
      const payload = await readJson(req);
      const nodes = await supabase(`/rest/v1/flow_nodes?select=*&flow_id=eq.${escapeFilter(flowId)}&order=created_at.asc`, { headers: { Authorization: `Bearer ${token}` } });
      const edges = await supabase(`/rest/v1/flow_edges?select=*&flow_id=eq.${escapeFilter(flowId)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!nodes.length) return json(res, 409, { error: 'Salve os blocos antes de simular.' });
      return json(res, 200, simulateGraph(nodes, edges, payload.input || '', payload.variables || {}));
    }
  }
  return json(res, 404, { error: 'Rota de API nao encontrada.' });
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
