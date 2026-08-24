import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Minus, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { InfoCallout } from '@/components/InfoCallout'
import { EnvChip } from '@/components/EnvChip'
import { grantRole, listRoleAssignments, listRoles, revokeRole } from '@/lib/accessApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/format'
import { PERMISSION_GROUPS, PERMISSION_META, permissionLabel } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { usePermissions } from '@/hooks/usePermissions'
import { useWorkspace } from '@/hooks/useWorkspace'
import { PERMISSIONS } from '@/types/api'
import type { Org, Permission, Role, RoleAssignment, ScopeType } from '@/types/api'

/** Value shape for the scope picker: one option per grantable scope in this org. */
interface ScopeOption {
  value: string
  scopeType: ScopeType
  scopeId: string
  label: string
  /** Just the name, for the assignments table. */
  name: string
}

/**
 * Roles and access.
 *
 * Two things have to be legible here that a raw API would never make legible on its own:
 * what a role actually lets someone do (hence a matrix of humanized capabilities, not a list
 * of enum names), and the fact that grants at different scopes UNION rather than override.
 * Someone with Viewer on the org and Approver on production can approve on production and
 * nowhere else, and that has to be readable from this page or the model is useless in
 * practice.
 */
export function AccessTab({ org }: { org: Org }) {
  const { toast } = useToast()
  const { projects, environments, project } = useWorkspace()
  const { refresh: refreshPermissions } = usePermissions()

  const [roles, setRoles] = useState<Role[]>([])
  const [assignments, setAssignments] = useState<RoleAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [roleKey, setRoleKey] = useState('')
  const [scopeValue, setScopeValue] = useState('')
  const [granting, setGranting] = useState(false)
  const [grantError, setGrantError] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<RoleAssignment | null>(null)
  const [revoking, setRevoking] = useState(false)

  // Every scope a role can be granted at, in the order the picker offers them: the org
  // first (widest), then this project, then its environments (narrowest).
  const scopeOptions = useMemo((): ScopeOption[] => {
    const options: ScopeOption[] = [
      {
        value: `ORG:${org.id}`,
        scopeType: 'ORG',
        scopeId: org.id,
        label: `${org.name} — the whole organization`,
        name: org.name,
      },
    ]
    for (const p of projects) {
      options.push({
        value: `PROJECT:${p.id}`,
        scopeType: 'PROJECT',
        scopeId: p.id,
        label: `${p.name} — every environment in the project`,
        name: p.name,
      })
    }
    if (project) {
      for (const env of environments) {
        options.push({
          value: `ENVIRONMENT:${env.id}`,
          scopeType: 'ENVIRONMENT',
          scopeId: env.id,
          label: `${project.name} / ${env.key}`,
          name: env.key,
        })
      }
    }
    return options
  }, [org, projects, project, environments])

  const scopeById = useMemo(
    () => new Map(scopeOptions.map((option) => [option.scopeId, option])),
    [scopeOptions],
  )

  const rolesByKey = useMemo(() => new Map(roles.map((role) => [role.key, role])), [roles])

  const load = useCallback(async () => {
    setError(null)
    try {
      const [roleList, assignmentList] = await Promise.all([
        listRoles(),
        listRoleAssignments(org.id),
      ])
      setRoles(roleList)
      setAssignments(assignmentList)
      setRoleKey((prev) => prev || roleList.find((r) => r.key === 'VIEWER')?.key || roleList[0]?.key || '')
    } catch (err) {
      setError(errorMessage(err, 'Could not load roles and assignments'))
    } finally {
      setLoading(false)
    }
  }, [org.id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    setScopeValue((prev) => prev || scopeOptions[0]?.value || '')
  }, [scopeOptions])

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault()
    const option = scopeOptions.find((o) => o.value === scopeValue)
    if (!email.trim() || !roleKey || !option) return
    setGranting(true)
    setGrantError(null)
    try {
      await grantRole(org.id, {
        email: email.trim(),
        roleKey,
        scopeType: option.scopeType,
        scopeId: option.scopeId,
      })
      toast({
        title: `${rolesByKey.get(roleKey)?.name ?? roleKey} granted to ${email.trim()}`,
        description: `At ${option.label}. Their permissions there are now the union of this and anything they already hold.`,
      })
      setEmail('')
      await load()
      // The grant may have been to the signed-in user; their own controls should update.
      await refreshPermissions()
    } catch (err) {
      setGrantError(errorMessage(err, 'Could not grant that role'))
    } finally {
      setGranting(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await revokeRole(org.id, revokeTarget.id)
      toast({
        title: `Revoked ${revokeTarget.roleKey} from ${revokeTarget.userEmail}`,
        description: 'Any role they hold at another scope still applies.',
      })
      setRevokeTarget(null)
      await load()
      await refreshPermissions()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Revoke failed', description: errorMessage(err) })
    } finally {
      setRevoking(false)
    }
  }

  // Grouped so the union rule is readable: one person, every scope they hold something at.
  const byUser = useMemo(() => {
    const map = new Map<string, RoleAssignment[]>()
    for (const assignment of assignments) {
      const list = map.get(assignment.userEmail) ?? []
      list.push(assignment)
      map.set(assignment.userEmail, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [assignments])

  if (loading) return <Skeleton className="h-96 w-full" />

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  }

  return (
    <div className="space-y-8">
      <InfoCallout dismissKey="switchboard.access.union">
        A role is granted at a scope — the organization, one project, or one environment — and
        permissions <strong>add up</strong> across the scopes that contain each other. Someone
        who is a Viewer on the org and an Approver on production reads everything and can
        approve changes on production only. Narrowing a role at a wider scope does not take
        anything away; revoke the wider grant instead.
      </InfoCallout>

      <section className="space-y-3" aria-labelledby="grant-heading">
        <h3 id="grant-heading" className="text-sm font-semibold">
          Grant a role
        </h3>
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border p-4"
          onSubmit={(e) => void handleGrant(e)}
        >
          <div className="min-w-[200px] flex-1 space-y-1.5">
            <Label htmlFor="grant-email">Email</Label>
            <Input
              id="grant-email"
              data-testid="grant-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
            />
          </div>
          <div className="w-44 space-y-1.5">
            <Label htmlFor="grant-role">Role</Label>
            <Select value={roleKey} onValueChange={setRoleKey}>
              <SelectTrigger id="grant-role" data-testid="grant-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.key} value={role.key}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[240px] flex-1 space-y-1.5">
            <Label htmlFor="grant-scope">Where</Label>
            <Select value={scopeValue} onValueChange={setScopeValue}>
              <SelectTrigger id="grant-scope" data-testid="grant-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" data-testid="grant-submit" disabled={granting || !email.trim()}>
            <UserPlus className="mr-1 h-4 w-4" />
            {granting ? 'Granting…' : 'Grant'}
          </Button>
          {roleKey && rolesByKey.get(roleKey) && (
            <p className="w-full text-xs text-muted-foreground" data-testid="grant-role-summary">
              {rolesByKey.get(roleKey)?.description} Grants:{' '}
              {rolesByKey
                .get(roleKey)!
                .permissions.map((p) => permissionLabel(p).toLowerCase())
                .join(', ')}
              .
            </p>
          )}
          {grantError && (
            <p className="w-full text-sm text-destructive" role="alert" data-testid="grant-error">
              {grantError}
            </p>
          )}
        </form>
      </section>

      <section className="space-y-3" aria-labelledby="assignments-heading">
        <h3 id="assignments-heading" className="text-sm font-semibold">
          Who has what
        </h3>
        {assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No roles have been granted yet.</p>
        ) : (
          <div className="space-y-4">
            {byUser.map(([userEmail, list]) => (
              <div key={userEmail} className="rounded-md border" data-testid={`access-user-${userEmail}`}>
                <div className="flex items-center gap-2 border-b px-4 py-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-medium">{userEmail}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    effective permissions = everything below, combined
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Role</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Grants</TableHead>
                      <TableHead>Granted</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((assignment) => {
                      const role = rolesByKey.get(assignment.roleKey)
                      const scope = scopeById.get(assignment.scopeId)
                      return (
                        <TableRow
                          key={assignment.id}
                          data-testid={`assignment-row-${assignment.id}`}
                        >
                          <TableCell>
                            <Badge variant="secondary">{role?.name ?? assignment.roleKey}</Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            {assignment.scopeType === 'ENVIRONMENT' && scope ? (
                              <EnvChip envKey={scope.name} />
                            ) : (
                              <span>
                                {scope?.name ?? 'unknown'}{' '}
                                <span className="text-xs text-muted-foreground">
                                  {assignment.scopeType === 'ORG' ? 'organization' : 'project'}
                                </span>
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[280px] text-xs text-muted-foreground">
                            {role
                              ? role.permissions.map((p) => permissionLabel(p)).join(', ')
                              : 'unknown role'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDateTime(assignment.createdAt)}
                            <div>by {assignment.createdBy}</div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Revoke ${assignment.roleKey} from ${assignment.userEmail}`}
                              data-testid={`revoke-${assignment.id}`}
                              onClick={() => setRevokeTarget(assignment)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </section>

      <RoleMatrix roles={roles} />

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {rolesByKey.get(revokeTarget?.roleKey ?? '')?.name ?? revokeTarget?.roleKey}{' '}
              from {revokeTarget?.userEmail}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They lose the permissions this grant gave them at{' '}
              {revokeTarget ? (scopeById.get(revokeTarget.scopeId)?.name ?? 'that scope') : ''}{' '}
              immediately. Roles they hold at other scopes are untouched, so they may still have
              access through one of those.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="revoke-confirm"
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void handleRevoke()
              }}
            >
              {revoking ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The role catalogue as a capability matrix. Rows are capabilities in plain words, columns
 * are roles — the arrangement you can actually read across when deciding whether Approver is
 * enough for someone, which a list of `FLAG_ROLLBACK`-style enum names is not.
 */
function RoleMatrix({ roles }: { roles: readonly Role[] }) {
  const grouped = useMemo(() => {
    return PERMISSION_GROUPS.map((group) => ({
      group,
      permissions: PERMISSIONS.filter((p) => PERMISSION_META[p].group === group),
    })).filter((section) => section.permissions.length > 0)
  }, [])

  return (
    <section className="space-y-3" aria-labelledby="roles-heading">
      <h3 id="roles-heading" className="text-sm font-semibold">
        What each role can do
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[220px]">Capability</TableHead>
              {roles.map((role) => (
                <TableHead key={role.key} className="text-center" title={role.description}>
                  {role.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.map((section) => (
              <RoleMatrixSection key={section.group} section={section} roles={roles} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function RoleMatrixSection({
  section,
  roles,
}: {
  section: { group: string; permissions: readonly Permission[] }
  roles: readonly Role[]
}) {
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell
          colSpan={roles.length + 1}
          className="py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {section.group}
        </TableCell>
      </TableRow>
      {section.permissions.map((permission) => (
        <TableRow key={permission} data-testid={`role-matrix-${permission}`}>
          <TableCell className="text-sm">
            <span className="font-medium">{PERMISSION_META[permission].label}</span>
            <p className="text-xs text-muted-foreground">
              {PERMISSION_META[permission].description}
            </p>
          </TableCell>
          {roles.map((role) => {
            const granted = role.permissions.includes(permission)
            return (
              <TableCell key={role.key} className="text-center">
                {granted ? (
                  <Check
                    className={cn('mx-auto h-4 w-4 text-ok-foreground')}
                    aria-label={`${role.name}: yes`}
                  />
                ) : (
                  <Minus
                    className="mx-auto h-4 w-4 text-muted-foreground/40"
                    aria-label={`${role.name}: no`}
                  />
                )}
              </TableCell>
            )
          })}
        </TableRow>
      ))}
    </>
  )
}
