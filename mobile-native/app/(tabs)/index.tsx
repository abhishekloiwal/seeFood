import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { API_BASE_URL, MAX_FILE_MB, MAX_FILES } from '@/constants/config';

type SelectedAsset = ImagePicker.ImagePickerAsset & {
  rejectedReason?: string;
};

type ProcessedPage = {
  name: string;
  url: string;
  page: number;
};

type MenuItem = {
  name: string;
  price: string;
  description: string;
  image_url: string;
  page: number;
};

const toMb = (bytes?: number) => (typeof bytes === 'number' ? bytes / (1024 * 1024) : 0);

const formatBytes = (bytes?: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(1)} ${units[index]}`;
};

const getExtension = (mimeType?: string) => {
  if (!mimeType) return 'jpg';
  const [, subtype] = mimeType.split('/');
  if (subtype === 'jpeg') return 'jpg';
  return subtype ?? 'jpg';
};

const resolveAssetUrl = (pathOrUrl?: string) => {
  if (!pathOrUrl) return '';
  try {
    return new URL(pathOrUrl, API_BASE_URL).toString();
  } catch {
    return pathOrUrl;
  }
};

const currencySymbolMap: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF',
  CAD: 'CAD',
  AUD: 'AUD',
  INR: '₹',
  JPY: '¥',
};

const normalizeAmount = (amount: string | undefined) => {
  if (!amount) return null;
  let sanitized = amount.replace(/[^\d.,]/g, '');
  if (!sanitized) return null;
  const commaIndex = sanitized.indexOf(',');
  const dotIndex = sanitized.indexOf('.');
  if (commaIndex !== -1 && dotIndex !== -1) {
    if (dotIndex < commaIndex) {
      sanitized = sanitized.replace(/\./g, '').replace(',', '.');
    } else {
      sanitized = sanitized.replace(/,/g, '');
    }
  } else if (commaIndex !== -1) {
    sanitized = sanitized.replace(',', '.');
  }
  const parsed = Number.parseFloat(sanitized);
  if (!Number.isFinite(parsed)) return null;
  const hasFraction = !Number.isInteger(parsed);
  return parsed.toFixed(hasFraction ? 2 : 0);
};

const renderCurrency = (unit: string, amount: string) =>
  unit.length === 1 ? `${unit}${amount}` : `${unit} ${amount}`;

const PRICE_REGEX =
  /(?:(?<symbol>[€$£¥₹])\s*(?<amount>\d[\d.,]*))|(?:(?<amount2>\d[\d.,]*)\s*(?<symbol2>[€$£¥₹]))|(?:(?<code>(?:EUR|USD|GBP|CHF|CAD|AUD|INR|JPY))\s*(?<amount3>\d[\d.,]*))|(?:(?<amount4>\d[\d.,]*)\s*(?<code2>(?:EUR|USD|GBP|CHF|CAD|AUD|INR|JPY)))/gi;

const formatPrice = (raw?: string) => {
  if (!raw) return '€ --';
  const trimmed = raw.trim();
  if (!trimmed) return '—';
  if (trimmed.toUpperCase() === 'N/A') return 'N/A';

  let match: RegExpExecArray | null;
  type PriceCandidate = { unit: string; amount: string; priority: number };
  let best: PriceCandidate | null = null;

  const consider = (unit: string, amount: string, priority: number) => {
    if (!best || priority > best.priority) {
      best = { unit, amount, priority };
    }
  };

  while ((match = PRICE_REGEX.exec(trimmed))) {
    const groups = match.groups ?? {};
    const amount =
      groups.amount ?? groups.amount2 ?? groups.amount3 ?? groups.amount4 ?? '';
    const normalized = normalizeAmount(amount);
    if (!normalized) continue;

    const symbol = groups.symbol ?? groups.symbol2;
    if (symbol) {
      const priority = symbol === currencySymbolMap.EUR ? 2 : 3;
      consider(symbol, normalized, priority);
      continue;
    }

    const code = groups.code ?? groups.code2;
    if (code) {
      const unit = currencySymbolMap[code] ?? code;
      const priority = code === 'EUR' ? 2 : 4;
      consider(unit, normalized, priority);
    }
  }

  if (best) {
    return renderCurrency(best.unit, best.amount);
  }

  const fallback = trimmed.match(/\d[\d.,]*/);
  if (fallback) {
    const normalized = normalizeAmount(fallback[0]);
    if (normalized) {
      return normalized;
    }
  }

  return trimmed;
};

const ensureFileSize = async (asset: ImagePicker.ImagePickerAsset): Promise<SelectedAsset> => {
  if (typeof asset.fileSize === 'number' && asset.fileSize > 0) {
    return { ...asset };
  }

  try {
    const info = await FileSystem.getInfoAsync(asset.uri);
    if (info.exists && typeof info.size === 'number') {
      return { ...asset, fileSize: info.size };
    }
  } catch {
    // best-effort; ignore failures and fall back to provided metadata
  }

  return { ...asset };
};

const evaluateAssets = (assets: SelectedAsset[]) => {
  const accepted: SelectedAsset[] = [];
  let rejection = '';

  assets.forEach((asset, index) => {
    if (accepted.length >= MAX_FILES) {
      if (!rejection) {
        rejection = `Only the first ${MAX_FILES} files are kept.`;
      }
      return;
    }

    const sizeMb = toMb(asset.fileSize);
    if (sizeMb > MAX_FILE_MB) {
      if (!rejection) {
        const label = asset.fileName ?? `File ${index + 1}`;
        rejection = `${label} exceeds the ${MAX_FILE_MB} MB limit.`;
      }
      return;
    }

    accepted.push(asset);
  });

  return { accepted, rejection };
};

export default function HomeScreen() {
  const [selectedAssets, setSelectedAssets] = useState<SelectedAsset[]>([]);
  const [pages, setPages] = useState<ProcessedPage[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(true);

  const scrollRef = useRef<ScrollView | null>(null);
  const resultsAnchorY = useRef(0);
  const previousItemCount = useRef(0);

  const hasAssets = selectedAssets.length > 0;
  const hasItems = items.length > 0;

  useEffect(() => {
    if (!hasAssets) {
      setIsPreviewExpanded(true);
    }
  }, [hasAssets]);

  useEffect(() => {
    if (hasItems && previousItemCount.current === 0) {
      setIsPreviewExpanded(false);
      const timeout = setTimeout(() => {
        if (resultsAnchorY.current > 0) {
          scrollRef.current?.scrollTo({
            y: Math.max(resultsAnchorY.current - 80, 0),
            animated: true,
          });
        }
      }, 220);
      return () => clearTimeout(timeout);
    }
    previousItemCount.current = items.length;
  }, [hasItems, items.length]);

  const applyAssets = async (
    incoming: ImagePicker.ImagePickerAsset[],
    mode: 'replace' | 'append' = 'replace',
  ) => {
    const combined =
      mode === 'replace' ? incoming : [...selectedAssets, ...incoming];
    const normalized = await Promise.all(combined.map(ensureFileSize));
    const { accepted, rejection } = evaluateAssets(normalized);

    setSelectedAssets(accepted);
    setErrorMessage(rejection);
    if (accepted.length > 0) {
      setIsPreviewExpanded(true);
    }
  };

  const handlePickImages = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) {
      Alert.alert('Permission required', 'We need access to your photo library to continue.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_FILES,
      quality: 1,
    });

    if (result.canceled) {
      return;
    }

    await applyAssets(result.assets ?? [], 'replace');
  };

  const handleCaptureImage = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) {
      Alert.alert('Permission required', 'Enable camera access to capture menu pages.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      cameraType: ImagePicker.CameraType.back,
    });

    if (result.canceled) {
      return;
    }

    await applyAssets(result.assets ?? [], 'append');
  };

  const handleReset = () => {
    setSelectedAssets([]);
    setPages([]);
    setItems([]);
    setSessionId('');
    setErrorMessage('');
  };

  const handleUpload = async () => {
    if (!selectedAssets.length) {
      setErrorMessage('Add at least one menu image to continue.');
      return;
    }

    const formData = new FormData();

    selectedAssets.forEach((asset, index) => {
      const extension = getExtension(asset.mimeType);
      const name =
        asset.fileName ??
        `menu-page-${index + 1}.${extension.startsWith('.') ? extension.slice(1) : extension}`;
      formData.append('menu_images', {
        uri: asset.uri,
        name,
        type: asset.mimeType ?? 'image/jpeg',
      } as unknown as Blob);
    });

    try {
      setIsLoading(true);
      setErrorMessage('');
      setPages([]);
      setItems([]);
      setSessionId('');

      const response = await fetch(`${API_BASE_URL}/api/process`, {
        method: 'POST',
        body: formData,
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = (await response.json().catch(() => ({}))) as {
        sessionId?: string;
        pages?: ProcessedPage[];
        items?: MenuItem[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Menu processing failed. Try again.');
      }

      const resolvedPages = (payload.pages ?? []).map((page) => ({
        ...page,
        url: resolveAssetUrl(page.url),
      }));

      const resolvedItems = (payload.items ?? []).map((item) => ({
        ...item,
        image_url: resolveAssetUrl(item.image_url),
        price: formatPrice(item.price),
      }));

      setSessionId(payload.sessionId ?? '');
      setPages(resolvedPages);
      setItems(resolvedItems);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error occurred.';
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  };

  const totalBytes = selectedAssets.reduce((sum, asset) => sum + (asset.fileSize ?? 0), 0);
  const selectedPagesLabel = `${selectedAssets.length} ${selectedAssets.length === 1 ? 'page' : 'pages'}`;
  const generatedPagesLabel = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;
  const generatedItemsLabel = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  const firstAsset = selectedAssets[0];

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.screen}
      contentContainerStyle={styles.content}
      stickyHeaderIndices={[0]}
    >
      <View style={styles.stickyBar}>
        <View style={styles.brandRow}>
          <View>
            <Text style={styles.brandTitle}>SeeFood</Text>
            <Text style={styles.brandTagline}>AI menu digitizer</Text>
          </View>
          {sessionId ? <Text style={styles.sessionChip}>Session {sessionId}</Text> : null}
        </View>
        <View style={styles.stickyActions}>
          <Pressable
            style={[
              styles.stickyButton,
              styles.stickyPrimaryButton,
              isLoading && styles.disabledButton,
            ]}
            onPress={handlePickImages}
            disabled={isLoading}
          >
            <Text style={styles.stickyPrimaryLabel}>Browse</Text>
          </Pressable>
          <Pressable
            style={[
              styles.stickyButton,
              styles.stickyGhostButton,
              isLoading && styles.disabledButton,
            ]}
            onPress={handleCaptureImage}
            disabled={isLoading}
          >
            <Text style={styles.stickyGhostLabel}>Capture</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.body}>
        {!hasAssets ? (
          <View style={styles.panel}>
            <Text style={styles.panelBadge}>Menu upload</Text>
            <Text style={styles.panelTitle}>Drop in your first menu</Text>
            <Text style={styles.panelSubtitle}>
              Snap a fresh photo or pull one from your library. We&apos;ll handle the rest.
            </Text>
            <Pressable
              style={[styles.primaryButton, isLoading && styles.disabledButton]}
              onPress={handlePickImages}
              disabled={isLoading}
            >
              <Text style={styles.primaryLabel}>Browse library</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, isLoading && styles.disabledButton]}
              onPress={handleCaptureImage}
              disabled={isLoading}
            >
              <Text style={styles.secondaryLabel}>Capture photo</Text>
            </Pressable>
            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
          </View>
        ) : (
          <View style={[styles.panel, styles.previewPanel]}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>Captured pages</Text>
                <Text style={styles.panelMeta}>
                  {selectedPagesLabel} · {formatBytes(totalBytes)}
                </Text>
              </View>
              <View style={styles.panelActions}>
                <Pressable onPress={() => setIsPreviewExpanded((prev) => !prev)}>
                  <Text style={styles.panelActionText}>
                    {isPreviewExpanded ? 'Hide preview' : 'Show preview'}
                  </Text>
                </Pressable>
                <Pressable onPress={handleReset} disabled={isLoading}>
                  <Text style={[styles.panelActionText, styles.panelReset]}>Start over</Text>
                </Pressable>
              </View>
            </View>

            {isPreviewExpanded ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.previewStrip}
                contentContainerStyle={styles.previewStripContent}
              >
                {selectedAssets.map((asset) => (
                  <View style={styles.previewCard} key={asset.assetId ?? asset.uri}>
                    <Image source={{ uri: asset.uri }} style={styles.previewImage} contentFit="cover" />
                    <View style={styles.previewInfo}>
                      <Text style={styles.previewName} numberOfLines={1}>
                        {asset.fileName ?? 'Selected image'}
                      </Text>
                      <Text style={styles.previewSize}>{formatBytes(asset.fileSize)}</Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Pressable style={styles.previewSummary} onPress={() => setIsPreviewExpanded(true)}>
                {firstAsset ? (
                  <Image source={{ uri: firstAsset.uri }} style={styles.previewThumb} contentFit="cover" />
                ) : null}
                <View style={styles.previewSummaryBody}>
                  <Text style={styles.previewSummaryText}>{selectedPagesLabel}</Text>
                  <Text style={styles.previewSummaryHint}>Tap to expand previews</Text>
                </View>
              </Pressable>
            )}

            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

            <Pressable
              style={[styles.primaryButton, isLoading && styles.disabledButton]}
              onPress={handleUpload}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryLabel}>Generate menu cards</Text>
              )}
            </Pressable>

            <View style={styles.secondaryRow}>
              <Pressable
                style={[styles.secondaryButton, isLoading && styles.disabledButton]}
                onPress={handlePickImages}
                disabled={isLoading}
              >
                <Text style={styles.secondaryLabel}>Add from library</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, isLoading && styles.disabledButton]}
                onPress={handleCaptureImage}
                disabled={isLoading}
              >
                <Text style={styles.secondaryLabel}>Capture another</Text>
              </Pressable>
            </View>
          </View>
        )}

        {hasItems ? (
          <View
            style={styles.section}
            onLayout={(event) => {
              resultsAnchorY.current = event.nativeEvent.layout.y;
            }}
          >
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionTitle}>Menu cards</Text>
                <Text style={styles.sectionHint}>Generated {generatedItemsLabel}</Text>
              </View>
              <Pressable onPress={handleReset}>
                <Text style={styles.sectionAction}>Start new menu</Text>
              </Pressable>
            </View>

            <View style={styles.resultsList}>
              {items.map((item, index) => (
                <View style={styles.resultCard} key={`${item.name}-${index}`}>
                  <Image source={{ uri: item.image_url }} style={styles.resultImage} contentFit="cover" />
                  <View style={styles.resultBody}>
                    <View style={styles.resultHeading}>
                      <Text style={styles.resultTitle}>{item.name}</Text>
                      <Text style={styles.resultPrice}>{item.price}</Text>
                    </View>
                    <Text style={styles.resultDescription}>{item.description}</Text>
                    <Text style={styles.resultBadge}>Page {item.page}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {pages.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Source pages</Text>
              <Text style={styles.sectionHint}>{generatedPagesLabel}</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.pagesStrip}
              contentContainerStyle={styles.pagesStripContent}
            >
              {pages.map((page) => (
                <View style={styles.pageThumb} key={`${page.page}-${page.url}`}>
                  <Image source={{ uri: page.url }} style={styles.pageImage} contentFit="cover" />
                  <Text style={styles.pageCaption}>Page {page.page}</Text>
                  <Text style={styles.pageName} numberOfLines={1}>
                    {page.name}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <Text style={styles.footer}>Built with Railway · Flask · Expo</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#080F1F',
  },
  content: {
    paddingBottom: 48,
  },
  stickyBar: {
    paddingTop: 48,
    paddingBottom: 18,
    paddingHorizontal: 20,
    gap: 14,
    backgroundColor: 'rgba(8, 14, 31, 0.96)',
    borderBottomWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.08)',
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
  },
  brandTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
  },
  brandTagline: {
    color: 'rgba(226, 232, 240, 0.66)',
    fontSize: 13,
    marginTop: 4,
  },
  sessionChip: {
    backgroundColor: 'rgba(59, 130, 246, 0.16)',
    color: '#BFDBFE',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: '600',
  },
  stickyActions: {
    flexDirection: 'row',
    gap: 12,
  },
  stickyButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyPrimaryButton: {
    backgroundColor: '#2563EB',
  },
  stickyGhostButton: {
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.35)',
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
  },
  stickyPrimaryLabel: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  stickyGhostLabel: {
    color: '#BFDBFE',
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.55,
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 24,
  },
  panel: {
    borderRadius: 24,
    padding: 24,
    gap: 16,
    backgroundColor: 'rgba(13, 23, 42, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.08)',
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 18 },
    elevation: 8,
  },
  previewPanel: {
    gap: 20,
  },
  panelBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(59, 130, 246, 0.16)',
    color: '#BFDBFE',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: '600',
  },
  panelTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
  },
  panelSubtitle: {
    color: 'rgba(203, 213, 225, 0.85)',
    fontSize: 14,
    lineHeight: 20,
  },
  panelMeta: {
    color: 'rgba(148, 163, 184, 0.8)',
    fontSize: 13,
    marginTop: 4,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
  },
  panelActions: {
    flexDirection: 'row',
    gap: 12,
  },
  panelActionText: {
    color: '#60A5FA',
    fontWeight: '700',
  },
  panelReset: {
    color: '#FCA5A5',
  },
  previewStrip: {
    flexGrow: 0,
  },
  previewStripContent: {
    paddingRight: 6,
    gap: 12,
  },
  previewCard: {
    width: 160,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
  },
  previewImage: {
    width: '100%',
    height: 140,
  },
  previewInfo: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  previewName: {
    color: '#E2E8F0',
    fontWeight: '600',
    fontSize: 13,
  },
  previewSize: {
    color: 'rgba(148, 163, 184, 0.75)',
    fontSize: 12,
  },
  previewSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
  },
  previewThumb: {
    width: 64,
    height: 64,
    borderRadius: 14,
  },
  previewSummaryBody: {
    flex: 1,
    gap: 4,
  },
  previewSummaryText: {
    color: '#F8FAFC',
    fontWeight: '600',
  },
  previewSummaryHint: {
    color: 'rgba(148, 163, 184, 0.75)',
    fontSize: 12,
  },
  primaryButton: {
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
  },
  primaryLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 12,
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37, 99, 235, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.35)',
  },
  secondaryLabel: {
    color: '#60A5FA',
    fontWeight: '600',
  },
  error: {
    marginTop: 4,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    color: '#FCA5A5',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontWeight: '600',
  },
  section: {
    backgroundColor: 'rgba(13, 23, 42, 0.55)',
    borderRadius: 24,
    padding: 24,
    gap: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.08)',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
  },
  sectionHint: {
    color: 'rgba(148, 163, 184, 0.8)',
    fontSize: 13,
    marginTop: 4,
  },
  sectionAction: {
    color: '#93C5FD',
    fontWeight: '600',
  },
  resultsList: {
    gap: 16,
  },
  resultCard: {
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.1)',
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 14 },
    elevation: 6,
  },
  resultImage: {
    width: '100%',
    height: 220,
  },
  resultBody: {
    padding: 18,
    gap: 12,
  },
  resultHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
  },
  resultTitle: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  resultPrice: {
    color: '#60A5FA',
    fontWeight: '700',
    fontSize: 16,
  },
  resultDescription: {
    color: 'rgba(203, 213, 225, 0.85)',
    fontSize: 14,
    lineHeight: 20,
  },
  resultBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(37, 99, 235, 0.18)',
    color: '#BFDBFE',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    fontSize: 12,
    fontWeight: '600',
  },
  pagesStrip: {
    flexGrow: 0,
  },
  pagesStripContent: {
    paddingRight: 6,
    gap: 12,
  },
  pageThumb: {
    width: 150,
    borderRadius: 20,
    padding: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
    gap: 8,
  },
  pageImage: {
    width: '100%',
    height: 160,
    borderRadius: 14,
  },
  pageCaption: {
    color: '#F8FAFC',
    fontWeight: '600',
    fontSize: 13,
  },
  pageName: {
    color: 'rgba(203, 213, 225, 0.8)',
    fontSize: 12,
  },
  footer: {
    textAlign: 'center',
    color: 'rgba(148, 163, 184, 0.7)',
    paddingBottom: 32,
    paddingTop: 8,
    fontSize: 12,
  },
});
