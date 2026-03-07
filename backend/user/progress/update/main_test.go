package main

import (
	"errors"
	"testing"

	"github.com/jackstenglein/chess-dojo-scheduler/backend/database"
)

func TestCheckNotification_NotifySenseisError_RecordMilestoneNotCalled(t *testing.T) {
	recordMilestoneCalled := false

	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			return []*database.Requirement{}, "", nil
		},
		notifySenseis: func(user *database.User, percent int) error {
			return errors.New("discord unavailable")
		},
		recordMilestone: func(username string, milestoneKey string) error {
			recordMilestoneCalled = true
			return nil
		},
	}

	user := &database.User{
		Username:  "testuser",
		DojoCohort: database.DojoCohort("0-300"),
		// No SentMilestoneNotifications, so milestone check will proceed
	}

	// GetPercentComplete with empty requirements and empty progress returns 0,
	// which is below threshold. We need to ensure the user reaches the threshold.
	// With no requirements, totalScore is 0, so GetPercentComplete returns 0.
	// We need at least one requirement the user has completed fully.
	// Instead, let's mock listRequirements to return a requirement that the user
	// has 100% progress on.

	req := &database.Requirement{
		Id:     "test-req",
		Status: database.Active,
		Counts: map[database.DojoCohort]int{
			"0-300": 1,
		},
	}

	mc.listRequirements = func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
		return []*database.Requirement{req}, "", nil
	}

	user.Progress = map[string]*database.RequirementProgress{
		"test-req": {
			RequirementId: "test-req",
			Counts: map[database.DojoCohort]int{
				"0-300": 1,
			},
		},
	}

	mc.checkNotification(user)

	if recordMilestoneCalled {
		t.Error("recordMilestone should NOT be called when notifySenseis returns an error")
	}
}

func TestCheckNotification_FetchRequirementsError_BailsOutCleanly(t *testing.T) {
	notifySenseisCalled := false
	recordMilestoneCalled := false

	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			return nil, "", errors.New("dynamodb timeout")
		},
		notifySenseis: func(user *database.User, percent int) error {
			notifySenseisCalled = true
			return nil
		},
		recordMilestone: func(username string, milestoneKey string) error {
			recordMilestoneCalled = true
			return nil
		},
	}

	user := &database.User{
		Username:   "testuser",
		DojoCohort: database.DojoCohort("0-300"),
	}

	// Should not panic
	mc.checkNotification(user)

	if notifySenseisCalled {
		t.Error("notifySenseis should NOT be called when fetchAllRequirements returns an error")
	}
	if recordMilestoneCalled {
		t.Error("recordMilestone should NOT be called when fetchAllRequirements returns an error")
	}
}

func TestCheckNotification_PartialSenseiFailure_ErrorPropagation(t *testing.T) {
	recordMilestoneCalled := false

	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			return []*database.Requirement{
				{
					Id:     "test-req",
					Status: database.Active,
					Counts: map[database.DojoCohort]int{"0-300": 1},
				},
			}, "", nil
		},
		notifySenseis: func(user *database.User, percent int) error {
			// Simulate partial failure: some DMs sent, some failed
			return errors.New("failed to send DM to 2 of 5 senseis")
		},
		recordMilestone: func(username string, milestoneKey string) error {
			recordMilestoneCalled = true
			return nil
		},
	}

	user := &database.User{
		Username:   "testuser",
		DojoCohort: database.DojoCohort("0-300"),
		Progress: map[string]*database.RequirementProgress{
			"test-req": {
				RequirementId: "test-req",
				Counts:        map[database.DojoCohort]int{"0-300": 1},
			},
		},
	}

	mc.checkNotification(user)

	if recordMilestoneCalled {
		t.Error("recordMilestone should NOT be called when notifySenseis returns a partial failure error")
	}
}

func TestCheckNotification_NilUser(t *testing.T) {
	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			t.Error("listRequirements should not be called for nil user")
			return nil, "", nil
		},
		notifySenseis: func(user *database.User, percent int) error {
			t.Error("notifySenseis should not be called for nil user")
			return nil
		},
		recordMilestone: func(username string, milestoneKey string) error {
			t.Error("recordMilestone should not be called for nil user")
			return nil
		},
	}

	// Should not panic
	mc.checkNotification(nil)
}

func TestCheckNotification_AlreadySentMilestone(t *testing.T) {
	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			t.Error("listRequirements should not be called when milestone already sent")
			return nil, "", nil
		},
		notifySenseis: func(user *database.User, percent int) error {
			t.Error("notifySenseis should not be called when milestone already sent")
			return nil
		},
		recordMilestone: func(username string, milestoneKey string) error {
			t.Error("recordMilestone should not be called when milestone already sent")
			return nil
		},
	}

	user := &database.User{
		Username:                   "testuser",
		DojoCohort:                 database.DojoCohort("0-300"),
		SentMilestoneNotifications: []string{"85_0-300"},
	}

	mc.checkNotification(user)
}

func TestFetchAllRequirements_ErrorOnFirstPage(t *testing.T) {
	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			return nil, "", errors.New("dynamodb error")
		},
	}

	reqs, err := mc.fetchAllRequirements("0-300")
	if err == nil {
		t.Error("fetchAllRequirements should return an error when listRequirements fails")
	}
	if reqs != nil {
		t.Errorf("fetchAllRequirements should return nil requirements on error, got %v", reqs)
	}
}

func TestFetchAllRequirements_ErrorOnSecondPage(t *testing.T) {
	callCount := 0
	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			callCount++
			if callCount == 1 {
				return []*database.Requirement{{Id: "req-1"}}, "next-page", nil
			}
			return nil, "", errors.New("dynamodb error on page 2")
		},
	}

	reqs, err := mc.fetchAllRequirements("0-300")
	if err == nil {
		t.Error("fetchAllRequirements should return an error when second page fails")
	}
	if reqs != nil {
		t.Errorf("fetchAllRequirements should return nil requirements on error, got %v", reqs)
	}
}

func TestCheckNotification_RecordMilestoneError_DoesNotPanic(t *testing.T) {
	mc := milestoneChecker{
		listRequirements: func(cohort database.DojoCohort, scoreboardOnly bool, startKey string) ([]*database.Requirement, string, error) {
			return []*database.Requirement{
				{
					Id:     "test-req",
					Status: database.Active,
					Counts: map[database.DojoCohort]int{"0-300": 1},
				},
			}, "", nil
		},
		notifySenseis: func(user *database.User, percent int) error {
			return nil
		},
		recordMilestone: func(username string, milestoneKey string) error {
			return errors.New("dynamodb write failed")
		},
	}

	user := &database.User{
		Username:   "testuser",
		DojoCohort: database.DojoCohort("0-300"),
		Progress: map[string]*database.RequirementProgress{
			"test-req": {
				RequirementId: "test-req",
				Counts:        map[database.DojoCohort]int{"0-300": 1},
			},
		},
	}

	// Should not panic even when recordMilestone fails
	mc.checkNotification(user)
}
