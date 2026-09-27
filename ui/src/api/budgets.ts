import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
} from "@paperclipai/shared";
import { api } from "./client";

export const budgetsApi = {
  overview: (companyId: string) =>
    api.get<BudgetOverview>(`/companies/${companyId}/budgets/overview`),
  upsertPolicy: (companyId: string, data: BudgetPolicyUpsertInput) =>
    api.post<BudgetPolicySummary>(`/companies/${companyId}/budgets/policies`, data),
  updatePolicy: (companyId: string, policyId: string, data: BudgetPolicyUpsertInput) =>
    api.patch<BudgetPolicySummary>(`/companies/${companyId}/budgets/policies/${encodeURIComponent(policyId)}`, data),
  deletePolicy: (companyId: string, policyId: string) =>
    api.delete<void>(`/companies/${companyId}/budgets/policies/${encodeURIComponent(policyId)}`),
  resolveIncident: (companyId: string, incidentId: string, data: BudgetIncidentResolutionInput) =>
    api.post<BudgetIncident>(
      `/companies/${companyId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
      data,
    ),
};
