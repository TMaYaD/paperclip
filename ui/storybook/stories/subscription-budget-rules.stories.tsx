import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { SubscriptionWindowBudgets } from "@/components/SubscriptionWindowBudgets";

const base: BudgetPolicySummary = {
  policyId: "openai-week", companyId: "company", scopeType: "company", scopeId: "company", scopeName: "Company",
  provider: "openai", metric: "subscription_percent", windowKind: "provider_week", amount: 100,
  progressive: true, releasedAmount: 0.3, observedAmount: 4, remainingAmount: 0, utilizationPercent: 4,
  releaseAt: "2026-09-27T09:43:20Z", warnPercent: 80, hardStopEnabled: true, notifyEnabled: true,
  isActive: true, status: "ok", paused: false, pauseReason: null,
  windowStart: new Date("2026-09-27T03:00:08Z"), windowEnd: new Date("2026-10-04T03:00:08Z"),
};
const meta = {
  title: "Finance/Subscription budget rules",
  component: SubscriptionWindowBudgets,
  parameters: { layout: "padded" },
  args: { onSave: async () => {}, onDelete: async () => {} },
} satisfies Meta<typeof SubscriptionWindowBudgets>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IndependentRelease: Story = { args: { policies: [
  base,
  { ...base, policyId: "anthropic-week", provider: "anthropic", observedAmount: 17, releasedAmount: 96.3, remainingAmount: 79.3, releaseAt: null, windowEnd: new Date("2026-09-27T10:00:00Z") },
  { ...base, policyId: "anthropic-session", provider: "anthropic", windowKind: "provider_session", progressive: false, amount: 80, releasedAmount: 80, observedAmount: 24, remainingAmount: 56, releaseAt: null, windowEnd: new Date("2026-09-27T07:40:00Z") },
] } };
export const UnknownAndStale: Story = { args: { policies: [
  { ...base, usageUnavailable: true, usageHeld: true, observedAmount: 0 },
  { ...base, policyId: "anthropic-week", provider: "anthropic", usageStale: true, usageHeld: true, observedAmount: 12, releasedAmount: 45, releaseAt: null, usageObservedAt: "2026-09-27T03:00:00Z" },
] } };
export const Empty: Story = { args: { policies: [] } };
