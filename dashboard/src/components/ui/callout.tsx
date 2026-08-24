import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const calloutVariants = cva(
  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
  {
    variants: {
      variant: {
        info: "border-border bg-muted/40 text-muted-foreground",
        warning: "border-warning/40 bg-warning/10 text-warning-foreground",
        danger: "border-destructive/40 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
)

export interface CalloutProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof calloutVariants> {
  icon?: LucideIcon
}

const Callout = React.forwardRef<HTMLDivElement, CalloutProps>(
  ({ className, variant, icon: Icon, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(calloutVariants({ variant }), className)}
      {...props}
    >
      {Icon && <Icon className="h-4 w-4 mt-0.5 shrink-0" />}
      <div className="flex-1 space-y-0.5">{children}</div>
    </div>
  )
)
Callout.displayName = "Callout"

// eslint-disable-next-line react-refresh/only-export-components
export { Callout, calloutVariants }
