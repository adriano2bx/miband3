plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.miband3.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.miband3.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "2.0"

        // Endereço do serviço BIOSENSE na nuvem (não é segredo). Defina com
        // -Pbiosense.cloudUrl=https://... ou a variável de ambiente BIOSENSE_CLOUD_URL.
        val cloudUrl = (project.findProperty("biosense.cloudUrl") as String?)
            ?: System.getenv("BIOSENSE_CLOUD_URL")
            ?: ""
        buildConfigField("String", "CLOUD_URL", "\"${cloudUrl.replace("\"", "")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    // org.json do Android é só um stub nos testes de JVM.
    testImplementation("org.json:json:20240303")
}
