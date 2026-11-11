import type { ReactNode } from "react";
import { CantonWorkspace } from "../../components/canton/workspace";
import "./canton.css";

export default function CantonLayout({ children }: { children: ReactNode }) {
  return <CantonWorkspace>{children}</CantonWorkspace>;
}
