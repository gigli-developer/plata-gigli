import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Proxy (ex-middleware en Next 16): refresca la sesión de Supabase y
// protege las rutas, redirigiendo a /login si no hay usuario.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isAuthRoute = path === "/login" || path.startsWith("/auth");

  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

/**
 * ⚠️ `api/` queda AFUERA a propósito.
 *
 * Este proxy redirige a /login cuando no hay sesión, y una request de máquina
 * (el webhook de Telegram, el canal PC) nunca trae cookies: sin esta exclusión
 * se comía el POST y devolvía el HTML del login con un 200, que es el peor error
 * posible — no falla, simplemente no pasa nada.
 *
 * Las rutas de `app/api/` NO quedan desprotegidas: cada una valida su propio
 * secreto compartido, que es más estricto que la sesión de navegador. Si algún
 * día se agrega una ruta de API que sí deba ir con sesión, se autentica adentro
 * del handler, no acá.
 */
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
