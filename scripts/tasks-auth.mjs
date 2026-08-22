// Autorización de Google Tasks.
// Uso: node scripts/tasks-auth.mjs   (desde la carpeta finanzas-app)
//
// Es un alias de `google-agenda-auth.mjs`, a propósito y no por vagancia: el OAuth
// de Tasks es EL MISMO que el de la agenda — un solo refresh token del proyecto
// publicado 838299317197 con los dos scopes juntos (calendar.events + tasks).
// Pedir solo el de Tasks generaría un token que PIERDE Calendar, así que no puede
// existir un "script solo de Tasks"; lo que sí puede existir es este nombre, para
// que "falta autorizar Google Tasks" diga qué correr sin obligar a saber que la
// agenda y las tareas comparten llave.
//
// El script real abre la URL de consentimiento y, al autorizar, guarda el
// GCAL_REFRESH_TOKEN nuevo directo en app_secrets (con la service role de
// .env.local). Si ese guardado fallara, avisa por consola: ahí sí hay que
// actualizar app_secrets a mano, clave GCAL_REFRESH_TOKEN.
await import("./google-agenda-auth.mjs");
