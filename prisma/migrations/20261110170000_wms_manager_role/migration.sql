-- WMS-50: rol de Gerencia (instrucciones del fundador, sección 5).
ALTER TABLE `membership_role` DROP CHECK `membership_role_role_check`;
ALTER TABLE `membership_role`
  ADD CONSTRAINT `membership_role_role_check`
  CHECK (`role` IN ('administrator', 'warehouse', 'buyer', 'viewer', 'supervisor', 'operator', 'forklift', 'manager'));
