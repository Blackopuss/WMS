-- WMS-59 (ADR 0062): roles de producción y calidad. Solo expansión: el
-- CHECK admite tres valores más.
ALTER TABLE `membership_role` DROP CHECK `membership_role_role_check`;
ALTER TABLE `membership_role`
  ADD CONSTRAINT `membership_role_role_check`
  CHECK (`role` IN ('administrator', 'warehouse', 'buyer', 'viewer', 'supervisor', 'operator', 'forklift', 'manager', 'production_operator', 'production_supervisor', 'quality_inspector'));
