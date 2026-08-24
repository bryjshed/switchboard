package com.switchboard.infrastructure.firebase;

import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.auth.FirebaseAuth;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class FirebaseConfig {

    private static final Logger log = LoggerFactory.getLogger(FirebaseConfig.class);

    @Value("${switchboard.firebase.project-id:demo-switchboard}")
    private String projectId;

    @Bean
    @ConditionalOnMissingBean(FirebaseAuth.class)
    public FirebaseAuth firebaseAuth() throws IOException {
        if (FirebaseApp.getApps().isEmpty()) {
            FirebaseOptions options;
            String emulatorHost = System.getenv("FIREBASE_AUTH_EMULATOR_HOST");
            if (emulatorHost != null && !emulatorHost.isEmpty()) {
                log.info("Initializing Firebase against auth emulator at {}", emulatorHost);
                options = FirebaseOptions.builder()
                    .setProjectId(projectId)
                    .setCredentials(GoogleCredentials.create(new AccessToken("dummy", null)))
                    .build();
            } else {
                options = FirebaseOptions.builder()
                    .setProjectId(projectId)
                    .setCredentials(GoogleCredentials.getApplicationDefault())
                    .build();
            }
            FirebaseApp.initializeApp(options);
        }
        return FirebaseAuth.getInstance();
    }
}
