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
          decided_by: string | null
          decision_note: string | null
          recorded_at: string
          risk_grade: string | null
        }
        Insert: {
          application_id: string
          decided_by?: string | null
          decision_note?: string | null
          recorded_at?: string
          risk_grade?: string | null
        }
        Update: {
          application_id?: string
          decided_by?: string | null
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

