export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      accounts: {
        Row: {
          balance: number
          created_at: string
          id: string
          kind: string
          name: string
          sort_order: number
        }
        Insert: {
          balance?: number
          created_at?: string
          id?: string
          kind: string
          name: string
          sort_order?: number
        }
        Update: {
          balance?: number
          created_at?: string
          id?: string
          kind?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      categories: {
        Row: {
          created_at: string
          id: string
          is_custom: boolean
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_custom?: boolean
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          is_custom?: boolean
          name?: string
        }
        Relationships: []
      }
      spending_limits: {
        Row: {
          category_id: string
          created_at: string
          id: string
          monthly_limit: number
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          monthly_limit: number
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          monthly_limit?: number
        }
        Relationships: [
          {
            foreignKeyName: "spending_limits_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: true
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      securities: {
        Row: {
          created_at: string
          id: string
          isin: string
          kind: string
          name: string
          nse_symbol: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          isin: string
          kind: string
          name: string
          nse_symbol?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          isin?: string
          kind?: string
          name?: string
          nse_symbol?: string | null
        }
        Relationships: []
      }
      investments: {
        Row: {
          as_of_date: string
          cost_value: number | null
          created_at: string
          hidden: boolean
          id: string
          price: number | null
          quantity: number
          security_id: string
          source: string
          updated_at: string
          value: number | null
        }
        Insert: {
          as_of_date: string
          cost_value?: number | null
          created_at?: string
          hidden?: boolean
          id?: string
          price?: number | null
          quantity: number
          security_id: string
          source: string
          updated_at?: string
          value?: number | null
        }
        Update: {
          as_of_date?: string
          cost_value?: number | null
          created_at?: string
          hidden?: boolean
          id?: string
          price?: number | null
          quantity?: number
          security_id?: string
          source?: string
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "investments_security_id_fkey"
            columns: ["security_id"]
            isOneToOne: false
            referencedRelation: "securities"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_snapshots: {
        Row: {
          as_of_date: string
          created_at: string
          holdings_count: number
          id: string
          source: string
          total_value: number
        }
        Insert: {
          as_of_date: string
          created_at?: string
          holdings_count?: number
          id?: string
          source?: string
          total_value: number
        }
        Update: {
          as_of_date?: string
          created_at?: string
          holdings_count?: number
          id?: string
          source?: string
          total_value?: number
        }
        Relationships: []
      }
      plan_settings: {
        Row: {
          expected_income: number
          id: boolean
          invest_threshold: number
          monthly_budget: number
          savings_goal: number
          updated_at: string
        }
        Insert: {
          expected_income?: number
          id?: boolean
          invest_threshold?: number
          monthly_budget?: number
          savings_goal?: number
          updated_at?: string
        }
        Update: {
          expected_income?: number
          id?: boolean
          invest_threshold?: number
          monthly_budget?: number
          savings_goal?: number
          updated_at?: string
        }
        Relationships: []
      }
      plan_items: {
        Row: {
          created_at: string
          decided_at: string | null
          id: string
          name: string
          note: string | null
          price: number
          status: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          id?: string
          name: string
          note?: string | null
          price: number
          status?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          id?: string
          name?: string
          note?: string | null
          price?: number
          status?: string
        }
        Relationships: []
      }
      plan_pool_events: {
        Row: {
          amount: number
          created_at: string
          id: string
          kind: string
          note: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          kind: string
          note?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
        }
        Relationships: []
      }
      transactions: {
        Row: {
          account_id: string
          amount: number
          category_id: string | null
          created_at: string
          id: string
          kind: string
          linked_account_id: string | null
          note: string | null
          occurred_at: string
          person: string | null
        }
        Insert: {
          account_id: string
          amount: number
          category_id?: string | null
          created_at?: string
          id?: string
          kind: string
          linked_account_id?: string | null
          note?: string | null
          occurred_at?: string
          person?: string | null
        }
        Update: {
          account_id?: string
          amount?: number
          category_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          linked_account_id?: string | null
          note?: string | null
          occurred_at?: string
          person?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_transaction: {
        Args: {
          p_account_id: string
          p_amount: number
          p_category_id: string
          p_kind: string
          p_linked_account_id: string
          p_note: string
          p_occurred_at: string
          p_person?: string
        }
        Returns: string
      }
      delete_transaction: { Args: { p_txn_id: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
