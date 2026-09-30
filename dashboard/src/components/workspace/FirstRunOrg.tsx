import { useState } from 'react'
import { Building2, MailCheck, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { toast } from '@/components/ui/use-toast'
import { errorMessage } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { CreateOrgDialog } from './CreateOrgDialog'

/**
 * What a signed-in person who belongs to no organization sees instead of a page.
 *
 * Every page needs an org, so before this existed such a person got an empty org picker and
 * "No project selected" with nothing to click. There are exactly two ways forward, and which one
 * applies is the server's call (`profile.canCreateOrg`), not a guess:
 *
 * - they may create an org — offered first, with the invitation route mentioned for someone who
 *   is actually trying to join a team;
 * - they may not (a self-hosted instance under the `bootstrap` policy, after its first org) —
 *   so the only honest message is "ask an admin to invite this email", with a reload for after.
 *
 * Invitations are accepted when the invitee signs in, and nothing is emailed, which is why the
 * address is spelled out: it has to match exactly what the admin types.
 *
 * They are accepted only for a VERIFIED address, and a Firebase email/password account starts
 * unverified — so an invited person could sit on this screen forever. When the provider reports
 * the address unverified, this adds a way to send the verification email and turns the reload
 * into "I've verified — check again", which forces a fresh token (carrying the new claim) before
 * re-reading /users/me, where the backend accepts the invitation.
 */
export function FirstRunOrg() {
  const { profile, reloadProfile, emailVerified, sendEmailVerification, refreshToken } = useAuth()
  const { refresh } = useWorkspace()
  const [createOpen, setCreateOpen] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [sending, setSending] = useState(false)

  const email = profile?.email ?? 'your email address'
  const canCreate = profile?.canCreateOrg === true
  // Only an explicit `false` counts. A provider that does not say (null) gets no nagging.
  const unverified = emailVerified === false
  const checkAfterVerifying = unverified && refreshToken !== undefined

  const reload = async () => {
    setReloading(true)
    try {
      // Order matters: the fresh token carries email_verified, /users/me is where the backend
      // accepts a pending invitation, and only after that will the org list contain the org.
      if (checkAfterVerifying) await refreshToken()
      await reloadProfile()
      await refresh()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not check again', description: errorMessage(err) })
    } finally {
      setReloading(false)
    }
  }

  const sendVerification = async () => {
    if (!sendEmailVerification) return
    setSending(true)
    try {
      await sendEmailVerification()
      toast({
        title: 'Verification email sent',
        description: `Open the link sent to ${email}, then come back and check again.`,
      })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not send the verification email',
        description: errorMessage(err),
      })
    } finally {
      setSending(false)
    }
  }

  const reloadButton = (
    <Button
      variant={canCreate ? 'ghost' : 'default'}
      size="sm"
      disabled={reloading}
      onClick={() => void reload()}
      data-testid="first-run-reload"
    >
      <RefreshCw className="mr-1 h-4 w-4" />
      {reloading ? 'Checking…' : checkAfterVerifying ? 'I’ve verified — check again' : 'Reload'}
    </Button>
  )

  const verifyNotice = unverified && (
    <Callout variant="warning" icon={MailCheck} className="text-left" data-testid="first-run-verify">
      <p className="font-medium">Verify your email to join organizations you’ve been invited to</p>
      {sendEmailVerification ? (
        <>
          <p>
            Invitations are accepted only for a verified address. We’ll send a link to{' '}
            <strong className="font-medium">{email}</strong>.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={sending}
            onClick={() => void sendVerification()}
            data-testid="first-run-send-verification"
          >
            {sending ? 'Sending…' : 'Send verification email'}
          </Button>
        </>
      ) : (
        <p>
          Your identity provider reports <strong className="font-medium">{email}</strong> as
          unverified, and invitations are accepted only for a verified address. Verify it with
          your identity provider, then sign in again.
        </p>
      )}
    </Callout>
  )

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 py-16 text-center" data-testid="first-run-org">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Building2 className="h-5 w-5 text-muted-foreground" aria-hidden />
      </div>

      {canCreate ? (
        <>
          <h2 className="text-xl font-semibold">Create your organization</h2>
          <p className="text-sm text-muted-foreground">
            An organization holds your projects, flags and team. You will be its owner.
          </p>
          <Button onClick={() => setCreateOpen(true)} data-testid="first-run-create-org">
            Create organization
          </Button>
          <div className="mt-6 space-y-2 border-t pt-6">
            <p className="text-sm text-muted-foreground" data-testid="first-run-join-hint">
              Joining a team instead? Ask an admin to invite{' '}
              <strong className="font-medium text-foreground">{email}</strong>, then reload.
            </p>
            {verifyNotice}
            {reloadButton}
          </div>
          <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
        </>
      ) : (
        <>
          <h2 className="text-xl font-semibold">You need an invitation</h2>
          <p className="text-sm text-muted-foreground" data-testid="first-run-invite-only">
            You are not a member of any organization yet, and this Switchboard instance does not
            let new accounts create one. Ask an admin to invite{' '}
            <strong className="font-medium text-foreground">{email}</strong> from Settings →
            Organization, then reload.
          </p>
          {verifyNotice}
          {reloadButton}
        </>
      )}
    </div>
  )
}
