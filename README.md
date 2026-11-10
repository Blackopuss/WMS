# WMS modular multiempresa

Plataforma WMS empresarial para cualquier industria: un solo núcleo, configurable por empresa y con módulos que se activan por separado. El rumbo está en las [instrucciones del fundador](docs/INSTRUCCIONES_WMS.md), que mandan sobre todo lo demás; ver también [Estado del WMS](docs/ESTADO_WMS.md) (lo que hay y lo que falta), [Plan WMS v3](docs/PLAN_WMS_V3.md) y la [especificación](docs/ESPECIFICACION_WMS_v5.md).

Rama de trabajo: `pruebas` (CI en GitHub Actions).

```powershell
npm install
# Primera vez: copia .env.example a .env.local y pon MYSQL_ROOT_PASSWORD
npm run setup      # secretos, bases, usuarios y migraciones
npm run db:seed    # cuenta demo: DEMO_EMAIL / DEMO_PASSWORD en .env.local
npm run demo:codigo  # código de verificación en dos pasos de la cuenta demo
npm run dev      # http://localhost:3000
npm run check    # tipos, lint, límites, formato y pruebas
# Correos en desarrollo: se guardan localmente; ábrelos en http://localhost:3000/correos
```

- [Memoria del proyecto](MEMORY.md): decisiones confirmadas del fundador y estado.

Antes de continuar el proyecto, leer las instrucciones, el estado y el plan v3.
