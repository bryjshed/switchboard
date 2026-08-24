import { NavLink, Outlet } from 'react-router-dom'
import {
  Activity,
  Flag,
  GitPullRequest,
  LogOut,
  ScrollText,
  Settings,
  Sparkles,
  ToggleLeft,
  Users2,
} from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { WorkspaceSwitchers } from './WorkspaceSwitchers'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'

const navGroups = [
  {
    label: 'Deliver',
    items: [
      { to: '/flags', label: 'Flags', icon: Flag },
      { to: '/segments', label: 'Segments', icon: Users2 },
    ],
  },
  {
    label: 'Observe',
    items: [
      { to: '/monitor', label: 'Monitor', icon: Activity },
      { to: '/change-requests', label: 'Change requests', icon: GitPullRequest },
      { to: '/ai/proposals', label: 'Proposals', icon: Sparkles },
      { to: '/activity', label: 'Activity', icon: ScrollText },
    ],
  },
  {
    label: 'Workspace',
    items: [{ to: '/settings', label: 'Settings', icon: Settings }],
  },
]

export function AppLayout() {
  const { profile, signOut } = useAuth()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="flex w-60 flex-shrink-0 flex-col border-r bg-card">
        <div className="flex items-center gap-2 border-b p-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ToggleLeft className="h-4 w-4" />
          </div>
          <h1 className="text-base font-semibold">Switchboard</h1>
        </div>
        <nav className="flex-1 overflow-y-auto p-4" aria-label="Main">
          {navGroups.map((group) => (
            <div key={group.label} className="mt-4 first:mt-0">
              <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    data-testid={`nav-${label.toLowerCase().replace(/\s+/g, '-')}`}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {profile && (
          <div className="border-t p-4">
            <p className="truncate text-xs text-muted-foreground" title={profile.email}>
              {profile.displayName || profile.email}
            </p>
          </div>
        )}
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-4 border-b bg-card px-6">
          <WorkspaceSwitchers />
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void signOut()}
              title="Sign out"
              aria-label="Sign out"
              data-testid="signout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
