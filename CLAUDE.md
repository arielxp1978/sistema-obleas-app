# sistema-obleas — Instrucciones para Claude

## Qué es esto

Procesador CSV de obleas GNC para Nova GNC. Corre en Server 18 (192.168.0.18:3080).
Repo: arielxp1978/sistema-obleas-app (público).

## Stack

- Node.js + Express
- PostgreSQL cdp_nova (VPS Hostinger 168.231.93.65:5435) — solo para auth de usuarios
- Deploy: Docker en Server 18, puerto 3080

## Auth

- Login principal: Google OAuth (@novagnc.com.ar) vía relay `https://panel.novagnc.com.ar/auth/google/callback-obleas`
- Fallback: clave `nova2026` (variable de entorno `APP_CLAVE`)
- Usuarios verificados en `panel.usuarios` (cdp_nova)

## Deploy

```bash
# Copiar archivos al server y rebuildar
sshpass -p 'Akeneo123.' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no <archivos> akeneo@192.168.0.18:/home/akeneo/sistema-obleas-app/
sshpass -p 'Akeneo123.' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no akeneo@192.168.0.18 "cd /home/akeneo/sistema-obleas-app && docker compose --env-file .env up -d --build"
```

Nota: el server no tiene acceso a GitHub directo (sale por gluetun). Siempre copiar archivos por SCP.

---

## OBLIGATORIO — Retorno al CEO al cerrar sesion

Si al abrir esta sesion existe una sesion activa en `agente-ceo/sesiones-activas.md` que menciona este proyecto:

1. Al terminar, escribir el archivo de retorno:
   `agente-ceo/retornos/YYYY-MM-DD-[nombre-sesion]-sistema-obleas.md`
   Usar el template en `agente-ceo/retornos/_template.md`

2. Actualizar `agente-ceo/sesiones-activas.md`: cambiar el estado de la etapa de este proyecto a "completado" y agregar lo que surgió nuevo.

3. Avisarle a Ariel: "Retorno escrito. Podés volver al CEO."

Esto es una excepcion permitida a la regla de aislamiento (igual que los encargos).
