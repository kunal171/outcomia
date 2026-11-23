import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, hasAccess, isPublicPath } from "./lib/gate";

/** Every app page and API route requires the gate cookie; the landing page
 * and the gate itself are public. */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (await hasAccess(request.cookies.get(GATE_COOKIE)?.value))
    return NextResponse.next();
  if (pathname.startsWith("/api/"))
    return NextResponse.json({ error: "Locked" }, { status: 401 });
  const unlock = new URL("/unlock", request.url);
  unlock.searchParams.set("next", pathname + search);
  return NextResponse.redirect(unlock);
}

export const config = {
  // Static assets, image optimization and files with an extension are not gated.
  matcher: ["/((?!_next/static|_next/image|.*\\.[\\w]+$).*)"],
};
