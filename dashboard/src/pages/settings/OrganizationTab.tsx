import { useCallback, useEffect, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
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
import { addOrgMember, listOrgMembers, removeOrgMember } from '@/lib/orgsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/format'
import { useAuth } from '@/hooks/useAuth'
import { usePermissionGate } from '@/hooks/usePermissions'
import type { Org, OrgMember, OrgRole } from '@/types/api'

export function OrganizationTab({ org }: { org: Org }) {
  const { toast } = useToast()
  const { profile } = useAuth()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('MEMBER')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null)
  const [removing, setRemoving] = useState(false)

  // Membership is an RBAC capability now, not a legacy org role: someone granted Admin at
  // the org can manage members without being an OWNER. The org role still decides the badge.
  const memberGate = usePermissionGate('MANAGE_MEMBERS')
  const canManage = memberGate.allowed
  const isOwner = org.role === 'OWNER'

  const load = useCallback(async () => {
    setError(null)
    try {
      setMembers(await listOrgMembers(org.id))
    } catch (err) {
      setError(errorMessage(err, 'Could not load members'))
    } finally {
      setLoading(false)
    }
  }, [org.id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      await addOrgMember(org.id, { email: email.trim(), role })
      toast({ title: `Added ${email.trim()}` })
      setEmail('')
      setRole('MEMBER')
      await load()
    } catch (err) {
      setAddError(errorMessage(err, 'Could not add that member'))
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await removeOrgMember(org.id, removeTarget.userId)
      toast({ title: `Removed ${removeTarget.email}` })
      setRemoveTarget(null)
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Remove failed', description: errorMessage(err) })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3" aria-labelledby="org-heading">
        <h3 id="org-heading" className="text-sm font-semibold">
          Organization
        </h3>
        <dl className="grid gap-4 rounded-md border p-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Name</dt>
            <dd className="text-sm font-medium">{org.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Slug</dt>
            <dd className="font-mono text-sm">{org.slug}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Your role</dt>
            <dd>
              <Badge variant={isOwner ? 'default' : 'secondary'}>{org.role}</Badge>
            </dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-xs text-muted-foreground">Created</dt>
            <dd className="text-sm">{formatDateTime(org.createdAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3" aria-labelledby="members-heading">
        <h3 id="members-heading" className="text-sm font-semibold">
          Members
        </h3>

        {canManage ? (
          <form
            className="flex flex-wrap items-end gap-2 rounded-md border p-4"
            onSubmit={(e) => void handleAdd(e)}
          >
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label htmlFor="member-email">Email</Label>
              <Input
                id="member-email"
                data-testid="member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
              />
            </div>
            <div className="w-40 space-y-1.5">
              <Label htmlFor="member-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
                <SelectTrigger id="member-role" data-testid="member-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="OWNER">Owner</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={adding || !email.trim()} data-testid="member-add">
              <UserPlus className="mr-1 h-4 w-4" />
              {adding ? 'Adding…' : 'Add member'}
            </Button>
            {addError && (
              <p className="w-full text-sm text-destructive" role="alert" data-testid="member-add-error">
                {addError}
              </p>
            )}
          </form>
        ) : (
          <InfoCallout>{memberGate.reason}</InfoCallout>
        )}

        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.userId} data-testid={`member-row-${member.email}`}>
                    <TableCell>
                      <div className="text-sm">{member.displayName || member.email}</div>
                      {member.displayName && (
                        <div className="text-xs text-muted-foreground">{member.email}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={member.role === 'OWNER' ? 'default' : 'secondary'}>
                        {member.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(member.joinedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && member.userId !== profile?.id && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${member.email}`}
                          data-testid={`member-remove-${member.email}`}
                          onClick={() => setRemoveTarget(member)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to every project in {org.name} immediately. Their past changes
              stay in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="member-remove-confirm"
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void handleRemove()
              }}
            >
              {removing ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
