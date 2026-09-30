import { useCallback, useEffect, useState } from 'react'
import { Link2, Trash2, UserPlus } from 'lucide-react'
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
import {
  createInvitation,
  listInvitations,
  listOrgMembers,
  removeOrgMember,
  revokeInvitation,
} from '@/lib/orgsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/format'
import { useAuth } from '@/hooks/useAuth'
import { usePermissionGate } from '@/hooks/usePermissions'
import type { Org, OrgInvitation, OrgMember, OrgRole } from '@/types/api'

/**
 * Where an invitee should go. Invitations are accepted when that person signs in, and nothing
 * is emailed, so the admin has to pass the address on themselves — this is it.
 */
function signInLink(): string {
  return `${window.location.origin}/login`
}

/**
 * Org details, members, and invitations.
 *
 * Adding people is an invitation, not a lookup: "Add member" used to 404 for anyone who had not
 * signed in yet, which is everyone you would want to add to a new org. An invitation for someone
 * who already has an account is accepted on the spot (the server answers ACCEPTED and they appear
 * in Members); otherwise it waits in Pending invitations until they first sign in with that email.
 */
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
  const [invitations, setInvitations] = useState<OrgInvitation[]>([])
  const [invitationsLoading, setInvitationsLoading] = useState(false)
  const [invitationsError, setInvitationsError] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<OrgInvitation | null>(null)
  const [revoking, setRevoking] = useState(false)

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

  // Listing invitations needs MANAGE_MEMBERS, so it is not even asked for without it — the
  // section is hidden rather than showing a 403.
  const loadInvitations = useCallback(async () => {
    setInvitationsError(null)
    try {
      setInvitations(await listInvitations(org.id))
    } catch (err) {
      setInvitationsError(errorMessage(err, 'Could not load invitations'))
    } finally {
      setInvitationsLoading(false)
    }
  }, [org.id])

  useEffect(() => {
    if (!canManage) return
    setInvitationsLoading(true)
    void loadInvitations()
  }, [canManage, loadInvitations])

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    const address = email.trim()
    if (!address) return
    setAdding(true)
    setAddError(null)
    try {
      const invitation = await createInvitation(org.id, { email: address, role })
      if (invitation.status === 'ACCEPTED') {
        toast({
          title: `Added ${invitation.email}`,
          description: `They already had an account, so they are a member of ${org.name} now.`,
        })
      } else {
        toast({
          title: `Invited ${invitation.email}`,
          description: `They join ${org.name} the first time they sign in with that email. Nothing is emailed — send them the sign-in link.`,
        })
      }
      setEmail('')
      setRole('MEMBER')
      await Promise.all([load(), loadInvitations()])
    } catch (err) {
      setAddError(errorMessage(err, 'Could not invite that address'))
    } finally {
      setAdding(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await revokeInvitation(org.id, revokeTarget.id)
      toast({ title: `Revoked the invitation for ${revokeTarget.email}` })
      setRevokeTarget(null)
      await loadInvitations()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Revoke failed', description: errorMessage(err) })
    } finally {
      setRevoking(false)
    }
  }

  const copySignInLink = async () => {
    try {
      await navigator.clipboard.writeText(signInLink())
      toast({ title: 'Sign-in link copied', description: signInLink() })
    } catch {
      // Clipboard access can be refused (insecure origin, permissions). Show the link instead.
      toast({ title: 'Copy failed — here is the link', description: signInLink() })
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
            onSubmit={(e) => void handleInvite(e)}
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
            <Button type="submit" disabled={adding || !email.trim()} data-testid="member-invite">
              <UserPlus className="mr-1 h-4 w-4" />
              {adding ? 'Inviting…' : 'Invite'}
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              Someone who already has an account is added straight away. Anyone else joins the
              first time they sign in with this email — no email is sent, so pass them the
              sign-in link.
            </p>
            {addError && (
              <p className="w-full text-sm text-destructive" role="alert" data-testid="member-invite-error">
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

      {canManage && (
        <section className="space-y-3" aria-labelledby="invitations-heading">
          <div className="flex items-center justify-between gap-4">
            <h3 id="invitations-heading" className="text-sm font-semibold">
              Pending invitations
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copySignInLink()}
              data-testid="copy-sign-in-link"
            >
              <Link2 className="mr-1 h-4 w-4" />
              Copy sign-in link
            </Button>
          </div>
          {invitationsLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : invitationsError ? (
            <p className="text-sm text-destructive" role="alert">
              {invitationsError}
            </p>
          ) : invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="invitations-empty">
              No one is waiting to join.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Invited</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((invitation) => (
                    <TableRow key={invitation.id} data-testid={`invitation-row-${invitation.email}`}>
                      <TableCell className="text-sm">{invitation.email}</TableCell>
                      <TableCell>
                        <Badge variant={invitation.role === 'OWNER' ? 'default' : 'secondary'}>
                          {invitation.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(invitation.createdAt)}
                        <div className="text-xs">by {invitation.invitedBy}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`invitation-revoke-${invitation.email}`}
                          onClick={() => setRevokeTarget(invitation)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke the invitation for {revokeTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Signing in with that email will no longer add them to {org.name}. You can invite
              them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="invitation-revoke-confirm"
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
