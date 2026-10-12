package com.miband3.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.miband3.app.R
import com.miband3.app.ui.theme.BType
import com.miband3.app.ui.theme.Tokens

/** Símbolo vetorial + "BIOSENSE" e "by DELTABOTS" em texto nativo (acessível). */
@Composable
fun BrandHeader(onBack: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.ScreenPadding)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                IconButton(onClick = onBack, modifier = Modifier.padding(end = 4.dp)) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = Tokens.TextPrimary)
                }
            }
            Image(
                painter = painterResource(R.drawable.ic_biosense_petroleo),
                contentDescription = null,
                modifier = Modifier.height(28.dp).width(24.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.semantics(mergeDescendants = true) {}) {
                Text(stringResource(R.string.brand_name), style = BType.brand)
                Text(stringResource(R.string.brand_signature), style = BType.footer.copy(letterSpacing = 1.sp))
            }
        }
        HorizontalDivider(color = Tokens.Outline)
    }
}

/** Lockup central da abertura (dimensão moderada, sem preencher a tela). */
@Composable
fun BrandLockup(modifier: Modifier = Modifier) {
    Column(modifier.semantics(mergeDescendants = true) {}, horizontalAlignment = Alignment.CenterHorizontally) {
        Image(painterResource(R.drawable.ic_biosense_petroleo), contentDescription = null, modifier = Modifier.height(64.dp).width(54.dp))
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.brand_name), style = BType.brand.copy(fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = 1.sp))
        Text(stringResource(R.string.brand_signature), style = BType.secondary.copy(letterSpacing = 2.sp))
    }
}

/**
 * Estrutura comum: cabeçalho, conteúdo rolável com margens de 20 dp e área inferior que
 * desce para o fim da tela quando sobra espaço, mas rola junto (nunca fica sobre o texto).
 */
@Composable
fun ScreenLayout(
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    bottom: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxSize().background(Tokens.Background).safeDrawingPadding().imePadding()) {
        BrandHeader(onBack)
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val minHeight = maxHeight
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Column(
                    Modifier.fillMaxWidth().heightIn(min = minHeight).padding(horizontal = Tokens.ScreenPadding, vertical = 20.dp),
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp), content = content)
                    if (bottom != null) {
                        Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = bottom)
                    }
                }
            }
        }
    }
}

@Composable
fun ScreenTitle(title: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = BType.screenTitle, modifier = Modifier.semantics { heading() })
        if (subtitle != null) Text(subtitle, style = BType.body.copy(color = Tokens.TextSecondary))
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, style = BType.section, modifier = modifier.semantics { heading() })
}

@Composable
fun BiosenseCard(modifier: Modifier = Modifier, padding: Dp = Tokens.CardPadding, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Tokens.CardRadius),
        color = Tokens.Surface,
        border = BorderStroke(1.dp, Tokens.Outline),
    ) {
        Column(Modifier.padding(padding), content = content)
    }
}

@Composable
fun CardDivider() = HorizontalDivider(Modifier.padding(vertical = 12.dp), color = Tokens.Outline)

/** Ícone em círculo suave (40 dp). */
@Composable
fun IconBadge(icon: ImageVector, tint: Color = Tokens.Primary, background: Color = Tokens.PrimarySoft, size: Dp = 40.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(background), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** Linha com ícone, título e descrição (itens do consentimento e da preparação). */
@Composable
fun FeatureRow(icon: ImageVector, title: String, description: String, trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
        IconBadge(icon)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = BType.section)
            Text(description, style = BType.secondary)
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        }
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, loading: Boolean = false) {
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Tokens.Primary,
            contentColor = Tokens.OnPrimary,
            disabledContainerColor = Tokens.Disabled,
            disabledContentColor = Tokens.TextSecondary,
        ),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.TextSecondary)
            Spacer(Modifier.width(12.dp))
        }
        Text(text, style = BType.body.copy(fontSize = 15.sp, color = Color.Unspecified), textAlign = TextAlign.Center)
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, if (enabled) Tokens.TextSecondary.copy(alpha = 0.6f) else Tokens.Outline),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Tokens.Primary, disabledContentColor = Tokens.TextSecondary),
    ) {
        Text(text, style = BType.body.copy(fontSize = 15.sp, color = Color.Unspecified), textAlign = TextAlign.Center)
    }
}

/** Indicador único de três segmentos usado em todas as etapas do tutorial. */
@Composable
fun GuidedStepIndicator(step: Int, total: Int = 3) {
    val label = stringResource(R.string.setup_step_of, step, total)
    Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(0.6f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(total) { i ->
                Box(
                    Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp))
                        .background(if (i < step) Tokens.Primary else Tokens.Outline),
                )
            }
        }
        Text(label, style = BType.secondary)
    }
}

/** Par rótulo/valor da área técnica. */
@Composable
fun InfoRow(label: String, value: String, valueColor: Color = Tokens.TextPrimary, leading: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
        Text(label, style = BType.secondary.copy(fontSize = 13.sp), modifier = Modifier.weight(0.42f))
        Row(Modifier.weight(0.58f), verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                leading()
                Spacer(Modifier.width(8.dp))
            }
            Text(value, style = BType.body.copy(fontSize = 13.sp, color = valueColor))
        }
    }
}

@Composable
fun StatusDot(color: Color) {
    Box(Modifier.size(10.dp).clip(CircleShape).background(color))
}

/** Mensagem de erro ou aviso dentro de um cartão, com ação opcional. */
@Composable
fun NoticeCard(icon: ImageVector, title: String, message: String, tint: Color = Tokens.Error, background: Color = Tokens.ErrorSoft, action: (@Composable () -> Unit)? = null) {
    BiosenseCard {
        Row(verticalAlignment = Alignment.Top, modifier = Modifier.semantics(mergeDescendants = true) {}) {
            IconBadge(icon, tint = tint, background = background, size = 36.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = BType.section)
                Text(message, style = BType.secondary)
            }
        }
        if (action != null) {
            Spacer(Modifier.height(12.dp))
            action()
        }
    }
}

@Composable
fun Footer(modifier: Modifier = Modifier) {
    Text(stringResource(R.string.footer), style = BType.footer, modifier = modifier)
}

/** Chip discreto (ex.: "Área técnica"). */
@Composable
fun Tag(text: String) {
    Box(
        Modifier.clip(RoundedCornerShape(50)).background(Tokens.PrimarySoft).border(0.dp, Color.Transparent, RoundedCornerShape(50))
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Text(text, style = BType.secondary.copy(color = Tokens.Primary, fontSize = 12.sp))
    }
}
