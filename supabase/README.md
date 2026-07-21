# Banco de dados ProWhats

1. No Supabase, abra **SQL Editor**.
2. Crie uma nova query, copie o conteúdo de `schema.sql` e clique em **Run**.
3. Em **Authentication > Providers**, habilite Email/Password para o primeiro acesso.
4. O backend criará a primeira empresa e o membro `owner` durante o onboarding.

## Segurança

- A chave `sb_secret_...` deve existir somente nas variáveis do backend/worker, nunca no browser.
- A chave publicável é usada somente pelo cliente autenticado e as políticas RLS deste schema limitam os dados à empresa do usuário.
- Tokens de WhatsApp devem ser criptografados antes de serem gravados em `connections.connection_config`.
