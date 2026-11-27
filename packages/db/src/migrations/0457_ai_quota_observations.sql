CREATE TABLE "ai_quota_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid,
	"provider" text NOT NULL,
	"window_key" text NOT NULL,
	"window_label" text,
	"used_percent" double precision NOT NULL,
	"resets_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_quota_observations_used_percent" CHECK ("ai_quota_observations"."used_percent" >= 0 and "ai_quota_observations"."used_percent" <= 100)
);--> statement-breakpoint
ALTER TABLE "ai_quota_observations" ADD CONSTRAINT "ai_quota_observations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_quota_observations" ADD CONSTRAINT "ai_quota_observations_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_quota_observations" ADD CONSTRAINT "ai_quota_observations_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_quota_observations_series_idx" ON "ai_quota_observations" USING btree ("company_id","connection_id","window_key","observed_at");
