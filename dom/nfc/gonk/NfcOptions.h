/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef NfcOptions_h
#define NfcOptions_h

#include "mozilla/dom/NfcOptionsBinding.h"
#include "mozilla/dom/MozNDEFRecordBinding.h"

namespace mozilla {

struct NDEFRecordStruct
{
  dom::TNF mTnf;
  nsTArray<uint8_t> mType;
  nsTArray<uint8_t> mId;
  nsTArray<uint8_t> mPayload;
};

struct CommandOptions
{
  CommandOptions(const mozilla::dom::NfcCommandOptions& aOther) {

#define COPY_FIELD(prop) prop = aOther.prop;

#define COPY_OPT_FIELD(prop, defaultValue)            \
  prop = aOther.prop.WasPassed() ? aOther.prop.Value() : defaultValue;

    COPY_FIELD(mType)
    COPY_FIELD(mRequestId)
    COPY_OPT_FIELD(mSessionId, 0)

    mRfState = aOther.mRfState.WasPassed() ?
                 static_cast<int32_t>(aOther.mRfState.Value()) :
                 0;

    COPY_OPT_FIELD(mTechType, 0)
    COPY_OPT_FIELD(mIsP2P, false)

    if (!aOther.mRecords.WasPassed()) {
      return;
    }

    mozilla::dom::Sequence<mozilla::dom::MozNDEFRecordOptions> const & currentValue = aOther.mRecords.InternalValue();
    int count = currentValue.Length();
    for (int32_t i = 0; i < count; i++) {
      NDEFRecordStruct record;
      record.mTnf = currentValue[i].mTnf;

      if (currentValue[i].mType.WasPassed()) {
        const dom::Uint8Array& type = currentValue[i].mType.Value();
        type.ComputeLengthAndData();
        record.mType.AppendElements(type.Data(), type.Length());
      }

      if (currentValue[i].mId.WasPassed()) {
        const dom::Uint8Array& id = currentValue[i].mId.Value();
        id.ComputeLengthAndData();
        record.mId.AppendElements(id.Data(), id.Length());
      }

      if (currentValue[i].mPayload.WasPassed()) {
        const dom::Uint8Array& payload = currentValue[i].mPayload.Value();
        payload.ComputeLengthAndData();
        record.mPayload.AppendElements(payload.Data(), payload.Length());
      }

      mRecords.AppendElement(record);
    }

#undef COPY_FIELD
#undef COPY_OPT_FIELD
  }

  nsString mType;
  int32_t mSessionId;
  nsString mRequestId;
  int32_t mRfState;
  int32_t mTechType;
  bool mIsP2P;
  nsTArray<NDEFRecordStruct> mRecords;
};

struct EventOptions
{
  EventOptions()
    : mType(EmptyString()), mStatus(-1), mErrorCode(-1), mSessionId(-1), mRequestId(EmptyString()),
      mMajorVersion(-1), mMinorVersion(-1), mIsP2P(-1),
      mTagType(-1), mMaxNDEFSize(-1), mIsReadOnly(-1), mIsFormatable(-1), mRfState(-1),
      mOriginType(-1), mOriginIndex(-1)
  {}

  nsString mType;
  int32_t mStatus;
  int32_t mErrorCode;
  int32_t mSessionId;
  nsString mRequestId;
  int32_t mMajorVersion;
  int32_t mMinorVersion;
  nsTArray<uint8_t> mTechList;
  bool mIsP2P;
  nsTArray<NDEFRecordStruct> mRecords;
  int32_t mTagType;
  int32_t mMaxNDEFSize;
  int32_t mIsReadOnly;
  int32_t mIsFormatable;
  int32_t mRfState;

  int32_t mOriginType;
  int32_t mOriginIndex;
  nsTArray<uint8_t> mAid;
  nsTArray<uint8_t> mPayload;
};

} // namespace mozilla

#endif
