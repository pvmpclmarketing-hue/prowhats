/* Interactive canvas for the ProWhats flow editor. */
(() => {
  const graphKey = 'prowhats_editor_graphs';
  const palette = ['Mensagem', 'Template WhatsApp', 'Menu', 'Carrossel', 'Aguarda resposta', 'Condicional', 'Etiquetas', 'Departamento', 'Kanban', 'Integração', 'Bloco de IA', 'Webhook', 'Finalizar'];
  const icons = ['✉', '▤', '≡', '▧', '◷', '◇', '♟', '♙', '▦', '⌁', '✦', '↗', '■'];
  const defaultGraph = () => ({
    nodes: [
      { id: 'start', type: 'Início', text: 'Mensagem recebida', x: 45, y: 305 },
      { id: 'message', type: 'Mensagem', text: 'Olá, {first_name}! Como posso ajudar?', x: 285, y: 305 },
      { id: 'wait', type: 'Aguarda resposta', text: 'Espera até 1 dia pela resposta', x: 535, y: 305 },
      { id: 'condition', type: 'Condicional', text: 'Resposta contém “atendimento”', x: 785, y: 205 },
      { id: 'human', type: 'Departamento', text: 'Enviar para Comercial', x: 1020, y: 205 },
      { id: 'ai', type: 'Bloco de IA', text: 'Classificar intenção do contato', x: 785, y: 430 }
    ],
    edges: [
      { source: 'start', target: 'message' }, { source: 'message', target: 'wait' },
      { source: 'wait', target: 'condition' }, { source: 'condition', target: 'human' }, { source: 'wait', target: 'ai' }
    ]
  });
  const loadGraphs = () => JSON.parse(localStorage.getItem(graphKey) || '{}');
  const persistGraph = (id, graph) => { const all = loadGraphs(); all[id] = graph; localStorage.setItem(graphKey, JSON.stringify(all)); };

  window.openEditor = function openInteractiveEditor(flowId) {
    const flows = JSON.parse(localStorage.getItem('prowhats_flows') || '[]');
    const flow = flows.find(item => item.id === flowId) || { id: flowId, name: 'Novo fluxo', active: false };
    const stored = loadGraphs()[flowId];
    const graph = stored || defaultGraph();
    let selectedId = graph.nodes[1]?.id || graph.nodes[0].id;
    let interaction = null;

    const nodeById = id => graph.nodes.find(node => node.id === id);
    const canvasPoint = event => { const area = document.querySelector('.pw-canvas-inner'); const box = area.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
    const edgeHtml = edge => {
      const source = nodeById(edge.source), target = nodeById(edge.target);
      if (!source || !target) return '';
      const x = source.x + 190, y = source.y + 52, dx = target.x - x, dy = target.y + 52 - y;
      const length = Math.hypot(dx, dy), angle = Math.atan2(dy, dx) * 180 / Math.PI;
      return `<i class="edge pw-edge" style="left:${x}px;top:${y}px;width:${length}px;transform:rotate(${angle}deg)"></i>`;
    };
    const nodeHtml = node => {
      const kind = node.type.includes('IA') ? 'ai' : node.type.includes('Aguarda') ? 'wait' : node.type === 'Condicional' ? 'condition' : '';
      return `<article class="node pw-node ${node.id === selectedId ? 'selected' : ''}" data-node-id="${node.id}" style="left:${node.x}px;top:${node.y}px" onpointerdown="ProWhatsEditor.dragNode(event, '${node.id}')"><span class="handle in"></span><div class="node-head ${kind}"><span>${node.type}</span><span>⋮</span></div><div class="node-body">${node.text}</div><span class="handle out" title="Arraste para conectar" onpointerdown="ProWhatsEditor.beginLink(event, '${node.id}')"></span></article>`;
    };
    function render() {
      const active = nodeById(selectedId) || graph.nodes[0];
      document.querySelector('#main-content').innerHTML = `<section class="editor"><header class="editor-header"><button class="button" onclick="navigate('flows')">← Fluxos</button><div class="editor-title"><h1>${flow.name}</h1><small>Editor visual · ${flow.active ? 'Ativo' : 'Pausado'} · salvo no navegador</small></div><button class="button" onclick="ProWhatsEditor.toggleFlow()">${flow.active ? 'Pausar' : 'Ativar'}</button><button class="button primary" onclick="ProWhatsEditor.simulate()">Simular</button></header><div class="canvas-wrap"><aside class="palette"><h3>Blocos</h3><p class="palette-tip">Arraste um bloco até o canvas ou clique para adicioná-lo.</p><div class="node-options">${palette.map((type, index) => `<button class="node-option" onpointerdown="ProWhatsEditor.beginPalette(event, '${type}')" onclick="ProWhatsEditor.addNode('${type}')"><span>${icons[index]}</span>${type}</button>`).join('')}</div></aside><section class="canvas pw-canvas"><div class="canvas-inner pw-canvas-inner">${graph.edges.map(edgeHtml).join('')}${graph.nodes.map(nodeHtml).join('')}</div><section class="simulator hidden" id="simulator"><div class="card-head"><div><h4>Simulador</h4><small>Teste local, sem WhatsApp</small></div><button onclick="document.querySelector('#simulator').classList.add('hidden')">×</button></div><div class="chat-bubble">Olá! Como posso ajudar?</div><form onsubmit="ProWhatsEditor.sendSimulation(event)"><input id="simulation-input" placeholder="Digite uma resposta..."><button class="button primary">Enviar</button></form></section></section><aside class="inspector"><h3>${active.type}</h3><p>Arraste este bloco para mover. Arraste o ponto verde à direita para criar uma conexão.</p><div class="field"><label>Conteúdo</label><textarea id="node-text">${active.text}</textarea></div><div class="field"><label>Variável de saída</label><input value="resposta_cliente"></div><button class="button primary" onclick="ProWhatsEditor.saveNode()">Salvar nó</button><button class="button danger" style="margin-top:9px" onclick="ProWhatsEditor.removeSelected()">Excluir nó</button></aside></div></section>`;
    }
    function saveGraph() { persistGraph(flowId, graph); }
    function addNode(type, point) {
      const sequence = graph.nodes.length + 1;
      const position = point || { x: 320 + (sequence % 3) * 80, y: 135 + (sequence % 4) * 70 };
      const node = { id: `node-${Date.now()}-${sequence}`, type, text: type === 'Mensagem' ? 'Digite sua mensagem aqui' : `Configure o bloco ${type}`, x: Math.max(15, position.x - 95), y: Math.max(15, position.y - 45) };
      graph.nodes.push(node); selectedId = node.id; saveGraph(); render();
    }
    function endInteraction(event) {
      if (!interaction) return;
      if (interaction.kind === 'link') {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-node-id]')?.dataset.nodeId;
        if (target && target !== interaction.source && !graph.edges.some(edge => edge.source === interaction.source && edge.target === target)) graph.edges.push({ source: interaction.source, target });
      }
      if (interaction.kind === 'palette') {
        const overCanvas = document.elementFromPoint(event.clientX, event.clientY)?.closest('.pw-canvas');
        if (overCanvas) addNode(interaction.type, canvasPoint(event));
      }
      interaction = null; document.querySelector('.pw-link-preview, .pw-node-ghost')?.remove(); saveGraph(); render();
    }
    document.addEventListener('pointermove', event => {
      if (!interaction) return;
      if (interaction.kind === 'drag') { const point = canvasPoint(event); const node = nodeById(interaction.id); node.x = Math.max(0, point.x - interaction.offsetX); node.y = Math.max(0, point.y - interaction.offsetY); const el = document.querySelector(`[data-node-id="${node.id}"]`); if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; } }
      if (interaction.kind === 'link') { const preview = document.querySelector('.pw-link-preview'); const source = nodeById(interaction.source), point = canvasPoint(event); const x = source.x + 190, y = source.y + 52, dx = point.x - x, dy = point.y - y; preview.style.width = `${Math.hypot(dx, dy)}px`; preview.style.left = `${x}px`; preview.style.top = `${y}px`; preview.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`; }
      if (interaction.kind === 'palette') { const ghost = document.querySelector('.pw-node-ghost'); const point = canvasPoint(event); if (ghost) { ghost.style.left = `${point.x - 95}px`; ghost.style.top = `${point.y - 25}px`; } }
    });
    document.addEventListener('pointerup', endInteraction);
    window.ProWhatsEditor = {
      dragNode(event, id) { if (event.button !== 0 || event.target.closest('.handle')) return; const point = canvasPoint(event), node = nodeById(id); selectedId = id; interaction = { kind: 'drag', id, offsetX: point.x - node.x, offsetY: point.y - node.y }; event.preventDefault(); },
      beginLink(event, source) { event.preventDefault(); event.stopPropagation(); const node = nodeById(source); interaction = { kind: 'link', source }; const preview = document.createElement('i'); preview.className = 'edge pw-link-preview'; preview.style.left = `${node.x + 190}px`; preview.style.top = `${node.y + 52}px`; document.querySelector('.pw-canvas-inner').append(preview); },
      beginPalette(event, type) { if (event.button !== 0) return; event.preventDefault(); interaction = { kind: 'palette', type }; const ghost = document.createElement('div'); ghost.className = 'pw-node-ghost'; ghost.textContent = type; document.querySelector('.pw-canvas-inner').append(ghost); },
      addNode(type) { if (!interaction) addNode(type); },
      saveNode() { const node = nodeById(selectedId); node.text = document.querySelector('#node-text').value.trim() || node.text; saveGraph(); render(); },
      removeSelected() { if (nodeById(selectedId)?.type === 'Início') return; graph.nodes = graph.nodes.filter(node => node.id !== selectedId); graph.edges = graph.edges.filter(edge => edge.source !== selectedId && edge.target !== selectedId); selectedId = graph.nodes[0].id; saveGraph(); render(); },
      toggleFlow() { flow.active = !flow.active; const updated = flows.map(item => item.id === flowId ? { ...item, active: flow.active } : item); localStorage.setItem('prowhats_flows', JSON.stringify(updated)); render(); },
      simulate() { document.querySelector('#simulator').classList.remove('hidden'); },
      sendSimulation(event) { event.preventDefault(); const input = document.querySelector('#simulation-input'); if (!input.value.trim()) return; const bubble = document.createElement('div'); bubble.className = 'chat-bubble'; bubble.style.background = '#f1f3f6'; bubble.textContent = input.value; input.closest('#simulator').insertBefore(bubble, input.closest('form')); input.value = ''; }
    };
    render();
  };
})();
