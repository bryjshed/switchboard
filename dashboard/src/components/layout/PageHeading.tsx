import type { ReactNode } from "react"

export interface PageHeadingProps {
  title: string
  description?: ReactNode
  children?: ReactNode
}

// Shared page header: a bold title with an optional description line
// underneath. `description` accepts a ReactNode so callers can embed an
// inline link, not just plain text.
export function PageHeading({ title, description, children }: PageHeadingProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      {description && (
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      )}
      {children}
    </div>
  )
}
