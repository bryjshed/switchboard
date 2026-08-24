import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import { useAuthStore } from '@features/auth/stores/authStore';
import { spacing, useTheme } from '@shared/theme';
import { Button, ScreenView, TextInput } from '@shared/ui';

export default function LoginScreen() {
  const { tokens, typography } = useTheme();
  const signIn = useAuthStore((s) => s.signIn);
  const signUp = useAuthStore((s) => s.signUp);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState<'in' | 'up' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (kind: 'in' | 'up') => {
    if (!email || !password || submitting) return;
    setSubmitting(kind);
    setError(null);
    try {
      await (kind === 'in' ? signIn(email.trim(), password) : signUp(email.trim(), password));
      // Success flips the auth gate; no navigation needed here.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <ScreenView bottomInset testID="login-screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md }}>
          <Text style={[typography.pageTitle, { color: tokens.text.primary }]}>Sign in</Text>
          <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
            Local stack: any account on the Firebase Auth emulator works. New email creates one.
          </Text>
          <TextInput
            testID="login-email"
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="you@example.com"
          />
          <TextInput
            testID="login-password"
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
          />
          {error ? (
            <Text style={[typography.bodySm, { color: tokens.status.error }]}>{error}</Text>
          ) : null}
          <Button
            testID="login-submit"
            label="Sign in"
            loading={submitting === 'in'}
            disabled={!email || !password}
            onPress={() => submit('in')}
          />
          <Button
            testID="login-create"
            label="Create account"
            variant="secondary"
            loading={submitting === 'up'}
            disabled={!email || !password}
            onPress={() => submit('up')}
          />
        </View>
      </KeyboardAvoidingView>
    </ScreenView>
  );
}
