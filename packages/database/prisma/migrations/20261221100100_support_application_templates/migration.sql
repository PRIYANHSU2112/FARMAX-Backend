-- notification-service templates for support.application_status_changed.v1 (PUSH falls back to IN_APP).
INSERT INTO "notification_templates" ("id", "key", "channel", "title", "body", "variables", "description") VALUES
  (gen_random_uuid(), 'support.application_approved', 'IN_APP', 'Your {{type}} application is approved',
   'Good news! FarmX approved your {{type}} application. Our team will contact you with next steps.',
   '[{"name":"type","type":"string","maxLength":20}]',
   'Applicant: dealer / partner application approved'),
  (gen_random_uuid(), 'support.application_rejected', 'IN_APP', 'Update on your {{type}} application',
   'FarmX could not approve your {{type}} application. Open the app to see the reason.',
   '[{"name":"type","type":"string","maxLength":20}]',
   'Applicant: dealer / partner application rejected');
