-- D-60: customer messages for quality-service events (recall notice, COA published).
INSERT INTO "notification_templates" ("id", "key", "channel", "title", "body", "variables", "description") VALUES
  (gen_random_uuid(), 'quality.batch_recalled', 'IN_APP', 'Do not use {{productName}} (batch {{batchNo}})',
   'The independent lab test of batch {{batchNo}} failed, so it has been withdrawn from sale. If you have it from order {{orderNo}}, keep it apart and do not use it. Open the certificate in the FarmX app for the result and return steps.',
   '[{"name":"productName","type":"string","maxLength":300},{"name":"batchNo","type":"string","maxLength":40},{"name":"orderNo","type":"string","maxLength":40}]',
   'Buyer: batch recalled (mandatory safety notice)'),
  (gen_random_uuid(), 'quality.coa_published', 'IN_APP', 'Lab result for {{productName}} is out',
   'The independent certificate for batch {{batchNo}} is published: the batch {{verdict}}. See both certificates in the FarmX app.',
   '[{"name":"productName","type":"string","maxLength":300},{"name":"batchNo","type":"string","maxLength":40},{"name":"verdict","type":"string","maxLength":10}]',
   'Buyer who asked to be notified: independent COA published');
