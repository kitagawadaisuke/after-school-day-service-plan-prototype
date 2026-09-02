begin;

alter table public.case_documents
  drop constraint case_documents_document_kind_check;

alter table public.case_documents
  add constraint case_documents_document_kind_check check (
    document_kind in (
      'basic_assessment',
      'consultation_plan',
      'individual_support_plan',
      'specialized_support_plan',
      'monitoring_record'
    )
  );

commit;
