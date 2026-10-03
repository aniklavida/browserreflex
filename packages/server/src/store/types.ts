// One definition of these two types: the decision schema owns them.
import type { DecisionPath, DecisionType } from '../core/schema.js';
export type { DecisionPath, DecisionType };
export type PatternStatus = 'candidate' | 'shadow' | 'active' | 'disabled' | 'demoted';
export type SessionStatus = 'active' | 'completed' | 'terminated' | string;

export interface Session {
  id: string;
  agent_name: string;
  status: SessionStatus;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertSession {
  id?: string;
  agent_name: string;
  status?: SessionStatus;
  metadata?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface UpdateSession {
  status?: SessionStatus;
  metadata?: string | null;
  updated_at?: string;
}

export interface Decision {
  id: string;
  session_id: string | null;
  url: string | null;
  domain: string | null;
  decision_type: DecisionType;
  question: string;
  context: string | null;
  input_hash: string | null;
  answer: string;
  confidence: number;
  path: DecisionPath;
  pattern_id: string | null;
  latency_ms: number;
  is_safety: number;
  needs_review: number;
  created_at: string;
}

export interface InsertDecision {
  id?: string;
  session_id?: string | null;
  url?: string | null;
  domain?: string | null;
  decision_type: DecisionType;
  question: string;
  context?: string | null;
  input_hash?: string | null;
  answer: string;
  confidence: number;
  path: DecisionPath;
  pattern_id?: string | null;
  latency_ms?: number;
  is_safety?: number | boolean;
  needs_review?: number | boolean;
  created_at?: string;
}

export interface DecisionFilter {
  session_id?: string;
  domain?: string;
  path?: DecisionPath;
  needs_review?: boolean;
  is_safety?: boolean;
  input_hash?: string;
  limit?: number;
  offset?: number;
}

export interface Feedback {
  id: string;
  decision_id: string;
  correct_value: string;
  note: string | null;
  source: string;
  created_at: string;
}

export interface InsertFeedback {
  id?: string;
  decision_id: string;
  correct_value: string;
  note?: string | null;
  source?: string;
  created_at?: string;
}

export interface Pack {
  id: string;
  name: string;
  version: string;
  description: string | null;
  is_active: number;
  signature: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertPack {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  is_active?: number | boolean;
  signature?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface UpdatePack {
  name?: string;
  version?: string;
  description?: string | null;
  is_active?: number | boolean;
  signature?: string | null;
  updated_at?: string;
}

export interface Pattern {
  id: string;
  pack_id: string | null;
  name: string;
  domain: string | null;
  url_pattern: string | null;
  selector: string | null;
  decision_type: DecisionType;
  rules: string;
  status: PatternStatus;
  confidence: number;
  is_safety: number;
  created_at: string;
  updated_at: string;
}

export interface InsertPattern {
  id?: string;
  pack_id?: string | null;
  name: string;
  domain?: string | null;
  url_pattern?: string | null;
  selector?: string | null;
  decision_type: DecisionType;
  rules: string;
  status?: PatternStatus;
  confidence?: number;
  is_safety?: number | boolean;
  created_at?: string;
  updated_at?: string;
}

export interface UpdatePattern {
  name?: string;
  domain?: string | null;
  url_pattern?: string | null;
  selector?: string | null;
  decision_type?: DecisionType;
  rules?: string;
  status?: PatternStatus;
  confidence?: number;
  is_safety?: number | boolean;
  updated_at?: string;
}

export interface PatternFilter {
  pack_id?: string;
  domain?: string;
  status?: PatternStatus;
  decision_type?: DecisionType;
  is_safety?: boolean;
  limit?: number;
  offset?: number;
}

export interface PatternStats {
  pattern_id: string;
  sample_count: number;
  agreed_count: number;
  disagreed_count: number;
  last_evaluated_at: string | null;
  updated_at: string;
}

export interface UpsertPatternStats {
  pattern_id: string;
  sample_count?: number;
  agreed_count?: number;
  disagreed_count?: number;
  last_evaluated_at?: string | null;
  updated_at?: string;
}

export interface Setting {
  key: string;
  value: string;
  updated_at: string;
}
