export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      application: {
        Row: {
          borrower_id: string
          created_at: string
          data: Json
          decided_at: string | null
          furthest_step: string | null
          id: string
          org_id: string
          revision: number
          state: string
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          borrower_id: string
          created_at?: string
          data?: Json
          decided_at?: string | null
          furthest_step?: string | null
          id?: string
          org_id: string
          revision?: number
          state?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          borrower_id?: string
          created_at?: string
          data?: Json
          decided_at?: string | null
          furthest_step?: string | null
          id?: string
          org_id?: string
          revision?: number
          state?: string
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_borrower_id_fkey"
            columns: ["borrower_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
      application_decision: {
        Row: {
          application_id: string
          decided_by: string
          decision_note: string | null
          recorded_at: string
          risk_grade: string | null
        }
        Insert: {
          application_id: string
          decided_by: string
          decision_note?: string | null
          recorded_at?: string
          risk_grade?: string | null
        }
        Update: {
          application_id?: string
          decided_by?: string
          decision_note?: string | null
          recorded_at?: string
          risk_grade?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_decision_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "application"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_decision_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "application_borrower_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_decision_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "application_lender_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_decision_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_release: {
        Row: {
          amount: number
          created_at: string
          decided_by: string | null
          decline_reason: string | null
          id: string
          loan_id: string
          purpose: string
          requested_by: string
          revision: number
          state: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          decided_by?: string | null
          decline_reason?: string | null
          id?: string
          loan_id: string
          purpose: string
          requested_by: string
          revision?: number
          state?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          decided_by?: string | null
          decline_reason?: string | null
          id?: string
          loan_id?: string
          purpose?: string
          requested_by?: string
          revision?: number
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_release_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan_balance_v"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "credit_release_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_release_note: {
        Row: {
          internal_note: string | null
          recorded_at: string
          recorded_by: string
          release_id: string
        }
        Insert: {
          internal_note?: string | null
          recorded_at?: string
          recorded_by: string
          release_id: string
        }
        Update: {
          internal_note?: string | null
          recorded_at?: string
          recorded_by?: string
          release_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_release_note_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_note_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: true
            referencedRelation: "credit_release"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_note_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: true
            referencedRelation: "credit_release_borrower_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_note_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: true
            referencedRelation: "credit_release_lender_v"
            referencedColumns: ["id"]
          },
        ]
      }
      document_slot: {
        Row: {
          application_id: string
          code: string
          created_at: string
          extract_required: string[]
          id: string
          label: string
          required: boolean
          revision: number
          state: string
          updated_at: string
          valid_until: string | null
        }
        Insert: {
          application_id: string
          code: string
          created_at?: string
          extract_required?: string[]
          id?: string
          label: string
          required?: boolean
          revision?: number
          state?: string
          updated_at?: string
          valid_until?: string | null
        }
        Update: {
          application_id?: string
          code?: string
          created_at?: string
          extract_required?: string[]
          id?: string
          label?: string
          required?: boolean
          revision?: number
          state?: string
          updated_at?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_slot_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_slot_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_borrower_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_slot_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_lender_v"
            referencedColumns: ["id"]
          },
        ]
      }
      document_upload: {
        Row: {
          bytes: number
          extracted: Json | null
          extraction_state: string
          filename: string
          id: string
          mime: string
          slot_id: string
          storage_path: string
          uploaded_at: string
        }
        Insert: {
          bytes: number
          extracted?: Json | null
          extraction_state?: string
          filename: string
          id?: string
          mime: string
          slot_id: string
          storage_path: string
          uploaded_at?: string
        }
        Update: {
          bytes?: number
          extracted?: Json | null
          extraction_state?: string
          filename?: string
          id?: string
          mime?: string
          slot_id?: string
          storage_path?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_upload_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "document_slot"
            referencedColumns: ["id"]
          },
        ]
      }
      eligibility_snapshot: {
        Row: {
          application_id: string
          created_at: string
          eligibility: Json
          id: string
          revision: number
        }
        Insert: {
          application_id: string
          created_at?: string
          eligibility: Json
          id?: string
          revision: number
        }
        Update: {
          application_id?: string
          created_at?: string
          eligibility?: Json
          id?: string
          revision?: number
        }
        Relationships: [
          {
            foreignKeyName: "eligibility_snapshot_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eligibility_snapshot_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_borrower_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eligibility_snapshot_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_lender_v"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_entry: {
        Row: {
          amount: number
          created_at: string
          effective: string
          id: number
          kind: string
          loan_id: string
          memo: string | null
          release_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          effective: string
          id?: number
          kind: string
          loan_id: string
          memo?: string | null
          release_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          effective?: string
          id?: number
          kind?: string
          loan_id?: string
          memo?: string | null
          release_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entry_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entry_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan_balance_v"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "ledger_entry_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: true
            referencedRelation: "credit_release"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entry_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: true
            referencedRelation: "credit_release_borrower_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entry_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: true
            referencedRelation: "credit_release_lender_v"
            referencedColumns: ["id"]
          },
        ]
      }
      loan: {
        Row: {
          application_id: string
          approved_limit: number
          borrower_id: string
          created_at: string
          id: string
          opened_at: string
          org_id: string
          product_id: string
          rate_bps: number
          status: string
        }
        Insert: {
          application_id: string
          approved_limit: number
          borrower_id: string
          created_at?: string
          id?: string
          opened_at?: string
          org_id: string
          product_id: string
          rate_bps: number
          status?: string
        }
        Update: {
          application_id?: string
          approved_limit?: number
          borrower_id?: string
          created_at?: string
          id?: string
          opened_at?: string
          org_id?: string
          product_id?: string
          rate_bps?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "loan_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_borrower_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "application_lender_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_borrower_id_fkey"
            columns: ["borrower_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "loan_product"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_product: {
        Row: {
          active: boolean
          criteria: Json
          id: string
          max_amount: number | null
          min_amount: number | null
          name: string
          org_id: string
          required_docs: Json
        }
        Insert: {
          active?: boolean
          criteria: Json
          id?: string
          max_amount?: number | null
          min_amount?: number | null
          name: string
          org_id: string
          required_docs: Json
        }
        Update: {
          active?: boolean
          criteria?: Json
          id?: string
          max_amount?: number | null
          min_amount?: number | null
          name?: string
          org_id?: string
          required_docs?: Json
        }
        Relationships: [
          {
            foreignKeyName: "loan_product_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
      organisation: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      profile: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          org_id: string | null
          role: Database["public"]["Enums"]["app_role"]
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          org_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          org_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
        }
        Relationships: [
          {
            foreignKeyName: "profile_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_event: {
        Row: {
          actor_id: string | null
          actor_role: Database["public"]["Enums"]["app_role"] | null
          created_at: string
          event: string
          from_state: string | null
          id: number
          machine: string
          payload: Json | null
          subject_id: string
          to_state: string
        }
        Insert: {
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["app_role"] | null
          created_at?: string
          event: string
          from_state?: string | null
          id?: number
          machine: string
          payload?: Json | null
          subject_id: string
          to_state: string
        }
        Update: {
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["app_role"] | null
          created_at?: string
          event?: string
          from_state?: string | null
          id?: number
          machine?: string
          payload?: Json | null
          subject_id?: string
          to_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_event_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_transition: {
        Row: {
          actor_role: Database["public"]["Enums"]["app_role"]
          event: string
          from_state: string
          machine: string
          to_state: string
        }
        Insert: {
          actor_role: Database["public"]["Enums"]["app_role"]
          event: string
          from_state: string
          machine: string
          to_state: string
        }
        Update: {
          actor_role?: Database["public"]["Enums"]["app_role"]
          event?: string
          from_state?: string
          machine?: string
          to_state?: string
        }
        Relationships: []
      }
    }
    Views: {
      application_borrower_v: {
        Row: {
          borrower_id: string | null
          created_at: string | null
          data: Json | null
          decided_at: string | null
          furthest_step: string | null
          id: string | null
          org_id: string | null
          revision: number | null
          state: string | null
          submitted_at: string | null
          updated_at: string | null
        }
        Insert: {
          borrower_id?: string | null
          created_at?: string | null
          data?: Json | null
          decided_at?: string | null
          furthest_step?: string | null
          id?: string | null
          org_id?: string | null
          revision?: number | null
          state?: string | null
          submitted_at?: string | null
          updated_at?: string | null
        }
        Update: {
          borrower_id?: string | null
          created_at?: string | null
          data?: Json | null
          decided_at?: string | null
          furthest_step?: string | null
          id?: string | null
          org_id?: string | null
          revision?: number | null
          state?: string | null
          submitted_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_borrower_id_fkey"
            columns: ["borrower_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
      application_lender_v: {
        Row: {
          borrower_id: string | null
          borrower_name: string | null
          created_at: string | null
          data: Json | null
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          furthest_step: string | null
          id: string | null
          open_doc_count: number | null
          org_id: string | null
          recorded_at: string | null
          revision: number | null
          risk_grade: string | null
          state: string | null
          submitted_at: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_borrower_id_fkey"
            columns: ["borrower_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_decision_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_release_borrower_v: {
        Row: {
          amount: number | null
          created_at: string | null
          decided_by: string | null
          decline_reason: string | null
          id: string | null
          loan_id: string | null
          purpose: string | null
          requested_by: string | null
          revision: number | null
          state: string | null
          updated_at: string | null
        }
        Insert: {
          amount?: number | null
          created_at?: string | null
          decided_by?: string | null
          decline_reason?: string | null
          id?: string | null
          loan_id?: string | null
          purpose?: string | null
          requested_by?: string | null
          revision?: number | null
          state?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number | null
          created_at?: string | null
          decided_by?: string | null
          decline_reason?: string | null
          id?: string | null
          loan_id?: string | null
          purpose?: string | null
          requested_by?: string | null
          revision?: number | null
          state?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "credit_release_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan_balance_v"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "credit_release_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_release_lender_v: {
        Row: {
          amount: number | null
          borrower_id: string | null
          created_at: string | null
          decided_by: string | null
          decided_by_name: string | null
          decline_reason: string | null
          id: string | null
          internal_note: string | null
          loan_id: string | null
          note_recorded_at: string | null
          note_recorded_by: string | null
          org_id: string | null
          purpose: string | null
          requested_by: string | null
          requested_by_name: string | null
          revision: number | null
          state: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "credit_release_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loan_balance_v"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "credit_release_note_recorded_by_fkey"
            columns: ["note_recorded_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_release_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_borrower_id_fkey"
            columns: ["borrower_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_balance_v: {
        Row: {
          approved_limit: number | null
          available: number | null
          borrower_id: string | null
          loan_id: string | null
          org_id: string | null
          outstanding: number | null
          pending: number | null
        }
        Relationships: [
          {
            foreignKeyName: "loan_borrower_id_fkey"
            columns: ["borrower_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisation"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      can_read_borrower_profile: {
        Args: { p_borrower: string }
        Returns: boolean
      }
      current_app_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      current_org_id: { Args: never; Returns: string }
      is_lender_of_application: {
        Args: { p_application: string }
        Returns: boolean
      }
      is_lender_of_org: { Args: { p_org: string }; Returns: boolean }
      is_lender_of_release: { Args: { p_release: string }; Returns: boolean }
    }
    Enums: {
      app_role: "borrower" | "lender" | "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["borrower", "lender", "admin"],
    },
  },
} as const

