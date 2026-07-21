# ProWhats

Painel inicial para automação de conversas no WhatsApp. A interface é funcional no navegador e armazena os fluxos no `localStorage` enquanto o backend definitivo é implementado.

## Executar

```powershell
npm start
```

Abra `http://localhost:3000`.

## Próximas integrações de produção

- WhatsApp Cloud API para envio, templates e webhooks oficiais.
- Adaptador não oficial isolado (QR Code), somente para contas que aceitem o risco operacional.
- Banco de dados PostgreSQL/Redis e fila de execução.
- Autenticação, permissões, registro de auditoria e logs de cada nó.
