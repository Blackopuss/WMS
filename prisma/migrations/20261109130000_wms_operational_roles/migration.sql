-- WMS-05: roles operativos de la especificación WMS v5 (4.2). Supervisor de
-- almacén (`supervisor`), Almacenista (`operator`) y Montacarguista
-- (`forklift`). Solo amplía la lista.
ALTER TABLE `membership_role` DROP CHECK `membership_role_role_check`;
ALTER TABLE `membership_role`
  ADD CONSTRAINT `membership_role_role_check`
  CHECK (`role` IN ('administrator', 'warehouse', 'buyer', 'viewer', 'supervisor', 'operator', 'forklift'));
