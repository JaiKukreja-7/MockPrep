/**
 * Hand-written to match supabase/migrations/20260905000000_init.sql.
 *
 * Once the project exists, replace this file wholesale with:
 *   npx supabase gen types typescript --project-id <ref> > lib/supabase/types.ts
 * and keep it regenerated in CI. Until then this is the contract, so any
 * schema change needs an edit here too.
 *
 * The row types below are `type` aliases, not interfaces, and must stay that
 * way: postgrest-js constrains them to Record<string, unknown>, and only type
 * aliases get TypeScript's implicit index signature. An interface here fails
 * the GenericSchema constraint and silently degrades every query to `never`.
 */

export type SessionStatus = "draft" | "live" | "scored" | "abandoned";
export type Track = "consulting" | "engineering" | "product" | "general";
export type Speaker = "interviewer" | "candidate";
export type RoundMode = "text" | "voice";
export type TranscriptFlag = "filler" | "restated" | "no_number" | "rambled";

export type UserRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  is_guest: boolean;
  daily_request_cap: number;
  daily_voice_sec_cap: number;
  created_at: string;
};

export type LlmUsageRow = {
  user_id: string;
  day: string;
  requests: number;
  voice_seconds: number;
};

export type SessionRow = {
  id: string;
  user_id: string;
  title: string;
  track: Track;
  status: SessionStatus;
  scheduled_for: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
};

export type RoundRow = {
  id: string;
  session_id: string;
  ordinal: number;
  mode: RoundMode;
  question: string;
  asked_at: string | null;
  answered_at: string | null;
  created_at: string;
};

export type ScoreRow = {
  session_id: string;
  overall: number;
  structure: number;
  specificity: number;
  pace: number;
  created_at: string;
};

export type TranscriptRow = {
  id: string;
  session_id: string;
  round_id: string | null;
  at_seconds: number;
  speaker: Speaker;
  body: string;
  start_ms: number | null;
  end_ms: number | null;
  flag: TranscriptFlag | null;
  created_at: string;
};

export type FlagSummaryRow = {
  user_id: string;
  flag: TranscriptFlag;
  flag_count: number;
  session_count: number;
};

type Writable<Row, Generated extends keyof Row, Optional extends keyof Row> =
  Omit<Row, Generated | Optional> & Partial<Pick<Row, Generated | Optional>>;

export interface Database {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: Writable<UserRow, "created_at", "email" | "display_name" | "is_guest" | "daily_request_cap" | "daily_voice_sec_cap">;
        Update: Partial<UserRow>;
        Relationships: [];
      };
      llm_usage: {
        Row: LlmUsageRow;
        Insert: LlmUsageRow;
        Update: Partial<LlmUsageRow>;
        Relationships: [];
      };
      sessions: {
        Row: SessionRow;
        Insert: Writable<
          SessionRow,
          "id" | "created_at",
          "track" | "status" | "scheduled_for" | "started_at" | "ended_at" | "duration_seconds"
        >;
        Update: Partial<SessionRow>;
        Relationships: [
          {
            foreignKeyName: "sessions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      rounds: {
        Row: RoundRow;
        Insert: Writable<RoundRow, "id" | "created_at", "asked_at" | "answered_at" | "mode">;
        Update: Partial<RoundRow>;
        Relationships: [
          {
            foreignKeyName: "rounds_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      scores: {
        Row: ScoreRow;
        Insert: Writable<ScoreRow, "created_at", never>;
        Update: Partial<ScoreRow>;
        Relationships: [
          {
            foreignKeyName: "scores_session_id_fkey";
            columns: ["session_id"];
            // session_id is also the primary key, so this embed is to-one.
            isOneToOne: true;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      transcripts: {
        Row: TranscriptRow;
        Insert: Writable<TranscriptRow, "id" | "created_at", "round_id" | "flag" | "start_ms" | "end_ms">;
        Update: Partial<TranscriptRow>;
        Relationships: [
          {
            foreignKeyName: "transcripts_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transcripts_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "rounds";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      flag_summary: {
        Row: FlagSummaryRow;
        Relationships: [];
      };
    };
    Functions: {
      consume_llm_quota: {
        Args: { p_cost?: number };
        Returns: { allowed: boolean; used: number; cap: number }[];
      };
      consume_voice_seconds: {
        Args: { p_seconds: number };
        Returns: { allowed: boolean; granted: number; used: number; cap: number }[];
      };
    };
    Enums: {
      round_mode: RoundMode;
      session_status: SessionStatus;
      track: Track;
      speaker: Speaker;
      transcript_flag: TranscriptFlag;
    };
    CompositeTypes: Record<never, never>;
  };
}
