-- Plan traffic used to be entered as decimal GB (1 GB = 1e9 bytes) while 3X-UI counts in 1024-based
-- GB (1 GB = 2^30 bytes). Plans are now stored 1024-based, so the same number the admin typed keeps
-- its meaning: multiply the stored byte value by 2^30 / 1e9.
UPDATE app_records
SET document = json_set(document, '$.trafficBytes', CAST(ROUND(json_extract(document, '$.trafficBytes') * 1073741824.0 / 1000000000.0) AS INTEGER))
WHERE collection = 'plans'
  AND json_extract(document, '$.trafficBytes') IS NOT NULL;

-- Accounts follow their plan: quota and level are copied from the (already converted) plan so the
-- panel never shows a quota the plan no longer grants.
UPDATE app_records
SET document = json_set(
  document,
  '$.planTrafficBytes', (SELECT json_extract(plan.document, '$.trafficBytes') FROM app_records AS plan WHERE plan.collection = 'plans' AND plan.record_id = json_extract(app_records.document, '$.planId')),
  '$.planLevel', (SELECT json_extract(plan.document, '$.level') FROM app_records AS plan WHERE plan.collection = 'plans' AND plan.record_id = json_extract(app_records.document, '$.planId'))
)
WHERE collection = 'users'
  AND EXISTS (
    SELECT 1 FROM app_records AS plan
    WHERE plan.collection = 'plans' AND plan.record_id = json_extract(app_records.document, '$.planId')
  );
