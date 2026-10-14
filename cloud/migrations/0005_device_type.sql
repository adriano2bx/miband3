-- Tipo do dispositivo: 'miband' (pulseira Mi Band, padrão) ou 'cgm' (sensor de
-- glicemia AiDEX). Um paciente é identificado por patient_ref e pode ter um device
-- de cada tipo (só pulseira, só CGM, ou os dois), agrupados pelo mesmo patient_ref.
ALTER TABLE devices ADD COLUMN type TEXT NOT NULL DEFAULT 'miband';

-- Qualquer device já vinculado à AiDEX passa a ser classificado como CGM.
UPDATE devices SET type = 'cgm' WHERE id IN (SELECT device_id FROM aidex_links);
