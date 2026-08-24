import { useState } from 'react'
import { Info, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { cn } from '@/lib/utils'

type InfoCalloutProps = {
  icon?: LucideIcon
  dismissKey?: string
  className?: string
  children: React.ReactNode
}

export function InfoCallout({ icon: Icon = Info, dismissKey, className, children }: InfoCalloutProps) {
  const [dismissed, setDismissed] = useState(
    () => (dismissKey ? localStorage.getItem(dismissKey) === '1' : false)
  )

  if (dismissed) return null

  return (
    <Callout
      variant="info"
      icon={Icon}
      className={cn('relative rounded-lg gap-3 px-4 py-3', dismissKey && 'pr-10', className)}
    >
      {children}
      {dismissKey && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            localStorage.setItem(dismissKey, '1')
            setDismissed(true)
          }}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </Callout>
  )
}
