/* What the map is made of, as one list.
 *
 * The radar composes nine layers over one projection; until now each was either
 * always on or hidden behind its own control. This is the single registry the
 * layers menu renders and the radar reads, so adding a layer is one entry here
 * and one `layers.x &&` in Radar, not a new control.
 *
 * Order within a group is drawing order, bottom first -- the menu reads the way
 * the map is stacked.
 */

export type MapLayerId =
  | 'basemap'
  | 'labels'
  | 'area'
  | 'grid'
  | 'heat'
  | 'zones'
  | 'frames'
  | 'routes'
  | 'vehicles';

export type MapLayers = Record<MapLayerId, boolean>;

export const DEFAULT_LAYERS: MapLayers = {
  basemap: true,
  labels: true,
  area: true,
  grid: true,
  // The density field stays off until asked for: it costs a pass over the whole
  // window and dims the fleet it is drawn under.
  heat: false,
  zones: true,
  frames: true,
  routes: true,
  vehicles: true,
};

export interface MapLayerSpec {
  id: MapLayerId;
  name: string;
  /** One line on what disappears when it is unticked. */
  description: string;
}

export interface MapLayerGroup {
  title: string;
  layers: MapLayerSpec[];
}

/** Altlık is the ground the day is drawn on; Veri is the day itself. */
export const LAYER_GROUPS: MapLayerGroup[] = [
  {
    title: 'ALTLIK',
    layers: [
      { id: 'basemap', name: 'Şehir haritası', description: 'Yollar, su ve yapılar' },
      { id: 'labels', name: 'Yer adları', description: 'Mahalle ve bölge etiketleri' },
      { id: 'area', name: 'Operasyon alanı', description: 'Tatbikatın sınır kutusu' },
      { id: 'grid', name: 'Mesafe halkaları', description: 'Üsse uzaklık çemberleri' },
    ],
  },
  {
    title: 'VERİ',
    layers: [
      { id: 'heat', name: 'Isı haritası', description: 'Araç yoğunluğu alanı' },
      { id: 'zones', name: 'Bölgeler', description: 'Kritik bölgeler ve tamponları' },
      { id: 'frames', name: 'Görüntü kareleri', description: 'Drone kare izleri' },
      { id: 'routes', name: 'Rota ve iz', description: 'Seçili aracın geçmiş yolu' },
      { id: 'vehicles', name: 'Araçlar', description: 'Canlı araç işaretleri' },
    ],
  },
];
