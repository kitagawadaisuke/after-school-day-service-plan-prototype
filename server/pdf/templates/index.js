import { renderBasicAssessment, BASIC_ASSESSMENT_ORIENTATION } from "./basic-assessment.js";
import { renderConsultationPlan, CONSULTATION_PLAN_ORIENTATION } from "./consultation-plan.js";
import { renderIndividualSupportPlan, INDIVIDUAL_SUPPORT_PLAN_ORIENTATION } from "./individual-support-plan.js";
import { renderMonitoringRecord, MONITORING_RECORD_ORIENTATION } from "./monitoring-record.js";

const TEMPLATES = Object.freeze({
  basic_assessment: Object.freeze({ render: renderBasicAssessment, orientation: BASIC_ASSESSMENT_ORIENTATION }),
  consultation_plan: Object.freeze({ render: renderConsultationPlan, orientation: CONSULTATION_PLAN_ORIENTATION }),
  individual_support_plan: Object.freeze({ render: renderIndividualSupportPlan, orientation: INDIVIDUAL_SUPPORT_PLAN_ORIENTATION }),
  monitoring_record: Object.freeze({ render: renderMonitoringRecord, orientation: MONITORING_RECORD_ORIENTATION }),
});

export function renderDocumentTemplate(source, snapshotKind) {
  const template = TEMPLATES[source?.document?.document_kind];
  if (!template) throw new TypeError("unsupported document kind for PDF rendering");
  return {
    html: template.render(source, snapshotKind),
    orientation: template.orientation,
  };
}

export const DOCUMENT_PDF_TEMPLATES = TEMPLATES;
