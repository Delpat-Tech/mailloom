import { request } from './api.js';

/** Agent keys ("Connections") for the active account. The key value is only ever returned once. */

export type AgentScope = 'read' | 'organise' | 'send';

export interface AgentKey {
  id: string;
  prefix: string;
  name: string;
  email: string;
  scopes: AgentScope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  broken_at: string | null;
  broken_reason: string | null;
  status: 'active' | 'revoked' | 'broken';
}

export interface AgentAuditEntry {
  at: string;
  key_prefix: string;
  tool: string;
  folder: string | null;
  message_id: string | null;
  recipients: string[] | null;
  subject: string | null;
  sent_message_id: string | null;
  status: number;
  result: string;
  workos_user: string | null;
  workos_session: string | null;
  ip: string;
}

export const connectionsApi = {
  list: () => request<{ agent_api_enabled: boolean; keys: AgentKey[] }>('/connections/keys'),
  create: (data: { name: string; scopes: AgentScope[]; password: string }) =>
    request<{ key: string; record: AgentKey }>('/connections/keys', { method: 'POST', body: JSON.stringify(data) }),
  rename: (id: string, name: string) =>
    request<{ record: AgentKey }>(`/connections/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  revoke: (id: string) =>
    request<{ record: AgentKey }>(`/connections/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  rotate: (id: string, password: string) =>
    request<{ key: string; record: AgentKey }>(`/connections/keys/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ password })
    }),
  audit: () => request<{ entries: AgentAuditEntry[] }>('/connections/audit')
};
