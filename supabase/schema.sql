-- ProWhats · schema inicial para Supabase PostgreSQL
-- Execute este arquivo uma única vez em Supabase Dashboard > SQL Editor.
-- Nenhuma chave de API é necessária neste script.

create extension if not exists pgcrypto;

-- Atualiza automaticamente o campo updated_at.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Empresas e acesso
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create type public.member_role as enum ('owner', 'admin', 'agent', 'viewer');

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'agent',
  created_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, user_id)
);

-- SECURITY DEFINER evita recursão das políticas de organization_members.
create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_organization(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- Conexões e webhooks
-- Nunca exponha connection_config a usuários não administradores.
-- Tokens devem ser criptografados pelo backend antes de persistir.
-- ---------------------------------------------------------------------------
create type public.connection_provider as enum ('whatsapp_cloud', 'whatsapp_qr', 'webhook');
create type public.connection_status as enum ('pending', 'connected', 'disconnected', 'error');

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  provider public.connection_provider not null,
  status public.connection_status not null default 'pending',
  phone_number text,
  connection_config jsonb not null default '{}'::jsonb,
  last_error text,
  connected_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, name)
);
create index connections_organization_id_idx on public.connections(organization_id);

create table public.inbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  secret_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, name)
);

-- ---------------------------------------------------------------------------
-- CRM: contatos, etiquetas, Kanban e departamentos
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_id text,
  phone_e164 text not null,
  name text,
  email text,
  avatar_url text,
  custom_fields jsonb not null default '{}'::jsonb,
  last_interaction_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, phone_e164)
);
create index contacts_organization_last_interaction_idx on public.contacts(organization_id, last_interaction_at desc);
create index contacts_organization_name_idx on public.contacts(organization_id, name);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  color text not null default '#10B981' check (color ~ '^#[A-Fa-f0-9]{6}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, name)
);

create table public.contact_tags (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (contact_id, tag_id)
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, name)
);

create table public.kanban_boards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.kanban_stages (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.kanban_boards(id) on delete cascade,
  name text not null,
  position integer not null check (position >= 0),
  color text not null default '#94A3B8' check (color ~ '^#[A-Fa-f0-9]{6}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (board_id, position)
);

create table public.kanban_cards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stage_id uuid not null references public.kanban_stages(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  title text not null,
  value_cents bigint check (value_cents is null or value_cents >= 0),
  currency char(3) not null default 'BRL',
  position numeric(20, 10) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index kanban_cards_organization_stage_idx on public.kanban_cards(organization_id, stage_id, position);

-- ---------------------------------------------------------------------------
-- Editor de fluxos: um fluxo possui nós e arestas independentes.
-- A configuração de cada nó fica em JSONB para permitir novos tipos sem migração.
-- ---------------------------------------------------------------------------
create type public.flow_status as enum ('draft', 'active', 'paused', 'archived');

create table public.flows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  status public.flow_status not null default 'draft',
  trigger_config jsonb not null default '{}'::jsonb,
  viewport jsonb not null default '{"x":0,"y":0,"zoom":1}'::jsonb,
  version integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index flows_organization_status_idx on public.flows(organization_id, status);

create table public.flow_nodes (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows(id) on delete cascade,
  node_key text not null,
  node_type text not null,
  position_x numeric(12, 2) not null default 0,
  position_y numeric(12, 2) not null default 0,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (flow_id, node_key)
);
create index flow_nodes_flow_id_idx on public.flow_nodes(flow_id);

create table public.flow_edges (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows(id) on delete cascade,
  source_node_id uuid not null references public.flow_nodes(id) on delete cascade,
  target_node_id uuid not null references public.flow_nodes(id) on delete cascade,
  source_handle text not null default 'success',
  label text,
  created_at timestamptz not null default timezone('utc', now()),
  constraint flow_edges_distinct_nodes check (source_node_id <> target_node_id),
  unique (source_node_id, target_node_id, source_handle)
);
create index flow_edges_flow_id_idx on public.flow_edges(flow_id);

-- ---------------------------------------------------------------------------
-- Conversas e execução. O worker do backend é o único processo que grava
-- os estados de execução e consome as mensagens pendentes.
-- ---------------------------------------------------------------------------
create type public.conversation_status as enum ('open', 'pending', 'closed');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_status as enum ('pending', 'sent', 'delivered', 'read', 'failed');
create type public.message_kind as enum ('text', 'image', 'audio', 'video', 'document', 'template', 'interactive', 'system');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete set null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  assigned_to uuid references auth.users(id) on delete set null,
  status public.conversation_status not null default 'open',
  automation_paused boolean not null default false,
  last_message_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index conversations_organization_status_idx on public.conversations(organization_id, status, last_message_at desc);
create index conversations_contact_idx on public.conversations(contact_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  provider_message_id text,
  direction public.message_direction not null,
  kind public.message_kind not null default 'text',
  status public.message_status not null default 'pending',
  content jsonb not null default '{}'::jsonb,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, provider_message_id)
);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);

create type public.flow_run_status as enum ('running', 'waiting', 'completed', 'failed', 'cancelled');
create type public.node_run_status as enum ('running', 'waiting', 'completed', 'failed', 'skipped');

create table public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  current_node_id uuid references public.flow_nodes(id) on delete set null,
  status public.flow_run_status not null default 'running',
  variables jsonb not null default '{}'::jsonb,
  wake_at timestamptz,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index flow_runs_worker_idx on public.flow_runs(status, wake_at) where status in ('running', 'waiting');
create index flow_runs_contact_idx on public.flow_runs(organization_id, contact_id, created_at desc);

create table public.node_runs (
  id uuid primary key default gen_random_uuid(),
  flow_run_id uuid not null references public.flow_runs(id) on delete cascade,
  node_id uuid not null references public.flow_nodes(id) on delete restrict,
  status public.node_run_status not null default 'running',
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);
create index node_runs_flow_run_idx on public.node_runs(flow_run_id, created_at);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
create index audit_logs_organization_created_idx on public.audit_logs(organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: todo registro de negócio pertence a uma organização.
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.connections enable row level security;
alter table public.inbound_webhooks enable row level security;
alter table public.contacts enable row level security;
alter table public.tags enable row level security;
alter table public.contact_tags enable row level security;
alter table public.departments enable row level security;
alter table public.kanban_boards enable row level security;
alter table public.kanban_stages enable row level security;
alter table public.kanban_cards enable row level security;
alter table public.flows enable row level security;
alter table public.flow_nodes enable row level security;
alter table public.flow_edges enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.flow_runs enable row level security;
alter table public.node_runs enable row level security;
alter table public.audit_logs enable row level security;

create policy "profiles self read" on public.profiles for select using (id = auth.uid());
create policy "profiles self update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles self insert" on public.profiles for insert with check (id = auth.uid());

create policy "organizations member read" on public.organizations for select using (public.is_organization_member(id));
create policy "organizations owner update" on public.organizations for update using (public.can_manage_organization(id));
create policy "members read own organization" on public.organization_members for select using (public.is_organization_member(organization_id));
create policy "members manage admins" on public.organization_members for all using (public.can_manage_organization(organization_id)) with check (public.can_manage_organization(organization_id));

-- Reusable policy pattern for tables with organization_id.
create policy "connections organization access" on public.connections for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "webhooks organization access" on public.inbound_webhooks for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "contacts organization access" on public.contacts for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "tags organization access" on public.tags for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "departments organization access" on public.departments for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "boards organization access" on public.kanban_boards for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "cards organization access" on public.kanban_cards for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "flows organization access" on public.flows for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "conversations organization access" on public.conversations for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "messages organization access" on public.messages for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "flow runs organization access" on public.flow_runs for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create policy "audit organization read" on public.audit_logs for select using (public.is_organization_member(organization_id));

-- Tabelas filhas obtêm a organização pelo pai.
create policy "contact tags organization access" on public.contact_tags for all using (exists (select 1 from public.contacts c where c.id = contact_id and public.is_organization_member(c.organization_id))) with check (exists (select 1 from public.contacts c where c.id = contact_id and public.is_organization_member(c.organization_id)));
create policy "stages organization access" on public.kanban_stages for all using (exists (select 1 from public.kanban_boards b where b.id = board_id and public.is_organization_member(b.organization_id))) with check (exists (select 1 from public.kanban_boards b where b.id = board_id and public.is_organization_member(b.organization_id)));
create policy "nodes organization access" on public.flow_nodes for all using (exists (select 1 from public.flows f where f.id = flow_id and public.is_organization_member(f.organization_id))) with check (exists (select 1 from public.flows f where f.id = flow_id and public.is_organization_member(f.organization_id)));
create policy "edges organization access" on public.flow_edges for all using (exists (select 1 from public.flows f where f.id = flow_id and public.is_organization_member(f.organization_id))) with check (exists (select 1 from public.flows f where f.id = flow_id and public.is_organization_member(f.organization_id)));
create policy "node runs organization access" on public.node_runs for select using (exists (select 1 from public.flow_runs r where r.id = flow_run_id and public.is_organization_member(r.organization_id)));

-- Atualização automática de data.
create trigger organizations_updated_at before update on public.organizations for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger connections_updated_at before update on public.connections for each row execute function public.set_updated_at();
create trigger webhooks_updated_at before update on public.inbound_webhooks for each row execute function public.set_updated_at();
create trigger contacts_updated_at before update on public.contacts for each row execute function public.set_updated_at();
create trigger boards_updated_at before update on public.kanban_boards for each row execute function public.set_updated_at();
create trigger cards_updated_at before update on public.kanban_cards for each row execute function public.set_updated_at();
create trigger flows_updated_at before update on public.flows for each row execute function public.set_updated_at();
create trigger nodes_updated_at before update on public.flow_nodes for each row execute function public.set_updated_at();
create trigger conversations_updated_at before update on public.conversations for each row execute function public.set_updated_at();
create trigger flow_runs_updated_at before update on public.flow_runs for each row execute function public.set_updated_at();

-- Cria perfil ao registrar um usuário. A organização inicial é criada pelo backend
-- após o onboarding para poder receber um slug validado e o usuário como owner.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
