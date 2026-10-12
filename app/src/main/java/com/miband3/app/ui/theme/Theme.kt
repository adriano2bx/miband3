package com.miband3.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Tokens BIOSENSE v1.0 (design/tokens.json). Tema claro apenas. */
object Tokens {
    val Primary = Color(0xFF126C64)
    val OnPrimary = Color(0xFFFFFFFF)
    val Background = Color(0xFFF6F8F7)
    val Surface = Color(0xFFFFFFFF)
    val TextPrimary = Color(0xFF121A1D)
    val TextSecondary = Color(0xFF52615F)
    val Outline = Color(0xFFDCE4E2)
    val Error = Color(0xFFB3261E)
    val Warning = Color(0xFF8A5A00)

    /** Fundo suave dos ícones em círculo (primária a ~10% sobre branco). */
    val PrimarySoft = Color(0xFFE7F1EF)
    val ErrorSoft = Color(0xFFF9E9E8)
    val WarningSoft = Color(0xFFF6EEDF)
    val Disabled = Color(0xFFDCE1E0)

    val ScreenPadding = 20.dp
    val CardPadding = 16.dp
    val CardRadius = 12.dp
    val MinTouch = 48.dp
}

@Immutable
data class BiosenseType(
    val brand: TextStyle,
    val screenTitle: TextStyle,
    val status: TextStyle,
    val section: TextStyle,
    val body: TextStyle,
    val secondary: TextStyle,
    val footer: TextStyle,
    val mono: TextStyle,
)

private val type = BiosenseType(
    brand = TextStyle(fontSize = 18.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, color = Tokens.TextPrimary),
    screenTitle = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, color = Tokens.TextPrimary),
    status = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, color = Tokens.TextPrimary),
    section = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, color = Tokens.TextPrimary),
    body = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, color = Tokens.TextPrimary),
    secondary = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, color = Tokens.TextSecondary),
    footer = TextStyle(fontSize = 11.sp, lineHeight = 16.sp, color = Tokens.TextSecondary),
    mono = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace, color = Tokens.TextPrimary),
)

val LocalBiosenseType = staticCompositionLocalOf { type }

private val colors = lightColorScheme(
    primary = Tokens.Primary,
    onPrimary = Tokens.OnPrimary,
    primaryContainer = Tokens.PrimarySoft,
    onPrimaryContainer = Tokens.Primary,
    background = Tokens.Background,
    onBackground = Tokens.TextPrimary,
    surface = Tokens.Surface,
    onSurface = Tokens.TextPrimary,
    surfaceVariant = Tokens.Background,
    onSurfaceVariant = Tokens.TextSecondary,
    outline = Tokens.Outline,
    outlineVariant = Tokens.Outline,
    error = Tokens.Error,
    onError = Tokens.OnPrimary,
)

private val typography = Typography(
    bodyLarge = type.body,
    bodyMedium = type.body,
    bodySmall = type.secondary,
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    titleMedium = type.section,
)

@Composable
fun BiosenseTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, typography = typography, content = content)
}

/** Atalho: `BType.body`, `BType.secondary`... */
val BType: BiosenseType
    @Composable get() = LocalBiosenseType.current
