import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Parlor for Android phones runs the same screens as Parlor on the iPhone (the desktop app's screens, with the
// iPhone's window.api in ios/support/ios-api.js); ios/scripts/prepare-web.sh puts them together, with the
// Android bridge (android/shared/android-shim.js) in front.
abstract class PrepareWeb : DefaultTask() {
    @get:InputDirectory abstract val rendererDir: DirectoryProperty
    @get:InputDirectory abstract val iosSupportDir: DirectoryProperty
    @get:InputDirectory abstract val sharedDir: DirectoryProperty
    @get:InputFile abstract val script: RegularFileProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val exec: ExecOperations

    @TaskAction
    fun run() {
        val out = outputDir.get().asFile
        exec.exec { commandLine("bash", script.get().asFile.absolutePath, File(out, "web").absolutePath, "--android") }
    }
}

val buildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

android {
    namespace = "com.screenroom.parlor"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.screenroom.parlor"
        minSdk = 29
        targetSdk = 34
        versionCode = buildNumber
        versionName = "0.5.$buildNumber"
    }

    // the same fixed key as the TV app, so each new build installs over the last one (keeping the library)
    signingConfigs {
        create("screenroom") {
            storeFile = file("../app/screenroom-release.jks")
            storePassword = "screenroom"
            keyAlias = "screenroom"
            keyPassword = "screenroom"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("screenroom")
        }
        debug {
            signingConfig = signingConfigs.getByName("screenroom")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

val prepareWeb = tasks.register<PrepareWeb>("prepareWeb") {
    rendererDir.set(file("../../renderer"))
    iosSupportDir.set(file("../../ios/support"))
    sharedDir.set(file("../shared"))
    script.set(file("../../ios/scripts/prepare-web.sh"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(prepareWeb, PrepareWeb::outputDir)
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.5.0")
    implementation("androidx.media3:media3-session:1.5.0")
    // FFmpeg audio decoders (Dolby Digital Plus, TrueHD, DTS …) built for Media3, published by the Jellyfin project:
    // most phones (Pixels among them) have no Dolby decoder of their own
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:1.5.0+1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
