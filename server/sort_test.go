package main

import "testing"

func TestSortRooms(t *testing.T) {
	rooms := []*Room{
		{Subject: "日曜1限", DayOfWeek: 0, Period: 1},
		{Subject: "水曜2限", DayOfWeek: 3, Period: 2},
		{Subject: "月曜3限", DayOfWeek: 1, Period: 3},
		{Subject: "金曜3限(授業中)", DayOfWeek: 5, Period: 3, IsOpen: true},
		{Subject: "月曜1限", DayOfWeek: 1, Period: 1},
		{Subject: "土曜1限", DayOfWeek: 6, Period: 1},
	}
	sortRooms(rooms)
	want := []string{"金曜3限(授業中)", "月曜1限", "月曜3限", "水曜2限", "土曜1限", "日曜1限"}
	for i, r := range rooms {
		if r.Subject != want[i] {
			got := make([]string, len(rooms))
			for k, x := range rooms {
				got[k] = x.Subject
			}
			t.Fatalf("並び順が違う:\n got  %v\n want %v", got, want)
		}
	}
}
